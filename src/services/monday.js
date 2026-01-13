// Simple aggregation: all time for all employees/clients/months (flat array)
export const buildFlatEmployeeClientMonthAggregation = (tasks) => {
  // Returns array of { employee, employeeId, client, month, totalMinutes }
  const map = new Map();
  tasks.forEach((task) => {
    const key = `${task.employeeId || task.employee}__${task.client}__${task.month}`;
    if (!map.has(key)) {
      map.set(key, {
        employee: task.employee,
        employeeId: task.employeeId,
        client: task.client,
        month: task.month,
        totalMinutes: 0
      });
    }
    map.get(key).totalMinutes += task.timeMinutes || 0;
  });
  return Array.from(map.values());
};

// Legacy aggregation used by /api/sync – now internally delegates to the
// same employee/client/month aggregation as the cron job so that the shape
// (including totalWorkedHours and totalClientHours) is consistent.
export const aggregateTasksByEmployeeMonthClient = (tasks) => {
  return aggregateTasksByEmployeeClientMonth(tasks);
};
import axios from 'axios'

const mondayClient = axios.create({
  baseURL: 'https://api.monday.com/v2/',
  headers: {
    'Content-Type': 'application/json'
  },
  timeout: 30000
})

const getAuthHeader = () => {
  if (!process.env.MONDAY_API_TOKEN) {
    throw new Error('Missing MONDAY_API_TOKEN')
  }
  return { Authorization: process.env.MONDAY_API_TOKEN }
}

const callMonday = async (query) => {
  try {
    const { data } = await mondayClient.post('', { query }, { headers: getAuthHeader() })
    if (data?.errors?.length) {
      const msg = data.errors[0]?.message || 'Monday.com API error'
      const locations = data.errors[0]?.locations?.map((l) => `${l.line}:${l.column}`).join(', ')
      console.error(`[MONDAY ERROR] ${msg}${locations ? ` (${locations})` : ''}`);
      throw new Error(`${msg}${locations ? ` (${locations})` : ''}`)
    }
    if (!data?.data) {
      console.error(`[MONDAY ERROR] Empty response from Monday.com API`);
      throw new Error('Empty response from Monday.com API')
    }
    return data.data
  } catch (error) {
    console.error(`[MONDAY ERROR] Network error:`, error.message);
    throw error;
  }
}

// --- Helpers for writing monthly summaries to a target board ---

// Find or create an item within a group representing a given monthKey (e.g. "2025-12")
export const getOrCreateMonthItem = async (boardId, groupId, monthKey) => {
  const query = `
    query {
      boards(ids: ${boardId}) {
        groups(ids: ["${groupId}"]) {
          items_page(limit: 500) {
            items {
              id
              name
            }
          }
        }
      }
    }
  `

  const data = await callMonday(query)
  const items = data?.boards?.[0]?.groups?.[0]?.items_page?.items || []
  const existing = items.find((i) => i?.name === monthKey)
  if (existing) return existing.id

  const mutation = `
    mutation {
      create_item (
        board_id: ${boardId},
        group_id: "${groupId}",
        item_name: "${monthKey}"
      ) {
        id
      }
    }
  `
  const mData = await callMonday(mutation)
  return mData?.create_item?.id
}

// Update one employee's month row on the target board using mapping:
// groupClientColumns[groupId][clientName] -> columnId
// columnTypes: map of columnId -> monday column type (e.g. 'numbers', 'text')
export const updateMonthRowForEmployee = async ({
  boardId,
  groupId,
  monthKey,
  employeeSummary,
  clientColumnMap,
  totalWorkedHoursColumnId,
  totalClientHoursColumnId,
  columnTypes
}) => {
  const itemId = await getOrCreateMonthItem(boardId, groupId, monthKey)
  if (!itemId) return

  const columnValues = {}

  const setValueForColumn = (columnId, value) => {
    if (!columnId) return
    const strVal = String(value)
    const colType = columnTypes?.[columnId]

    // For change_multiple_column_values via GraphQL, the value should be the raw value,
    // not an object. Numbers/text both accept a simple string representation.
    // We still skip complex/unsupported types.
    if (colType === 'numbers' || colType === 'numeric' || colType === 'text' || colType === 'long-text' || !colType) {
      columnValues[columnId] = strVal
    }
    // else: unsupported complex type (status, people, etc.) – skip
  }

  Object.entries(employeeSummary).forEach(([key, value]) => {
    if (key === 'employeeName' || key === 'employeeId' || key === 'otherClients') {
      return
    }

    if (typeof value !== 'number') return

    const columnId = clientColumnMap?.[key]
    if (!columnId) return

    setValueForColumn(columnId, value)
  })

  // Totals
  if (totalWorkedHoursColumnId && typeof employeeSummary.totalWorkedHours === 'number') {
    setValueForColumn(totalWorkedHoursColumnId, employeeSummary.totalWorkedHours)
  }
  if (totalClientHoursColumnId && typeof employeeSummary.totalClientHours === 'number') {
    setValueForColumn(totalClientHoursColumnId, employeeSummary.totalClientHours)
  }

  if (Object.keys(columnValues).length === 0) return

  const columnValuesStr = JSON.stringify(columnValues).replace(/"/g, '\\"')


  const mutation = `
    mutation {
      change_multiple_column_values(
        board_id: ${boardId},
        item_id: ${itemId},
        column_values: "${columnValuesStr}"
      ) {
        id
      }
    }
  `

  await callMonday(mutation)
  return itemId
}

// Replace existing "other clients" subitems for a month row with fresh ones
// Returns the newly created subitems
export const syncOtherClientsAsSubitems = async ({ parentItemId, otherClients, subitemWorkedHoursColumnId }) => {
  if (!parentItemId || !Array.isArray(otherClients) || otherClients.length === 0) return []

  // Fetch existing subitems
  const query = `
    query {
      items (ids: [${parentItemId}]) {
        id
        subitems {
          id
        }
      }
    }
  `

  const data = await callMonday(query)
  const subitems = data?.items?.[0]?.subitems || []

  // Archive existing subitems to avoid duplicates
  for (const s of subitems) {
    if (!s?.id) continue
    const archiveMutation = `
      mutation {
        archive_item (item_id: ${s.id}) {
          id
        }
      }
    `
    await callMonday(archiveMutation)
  }

  // Create new subitems from otherClients (using item_name as client name and setting worked hours column)
  // And collect the created subitems to return them
  const createdSubitems = [];
  for (const client of otherClients) {
    // Prepare column values for the subitem creation
    let columnValuesParam = '';
    if (subitemWorkedHoursColumnId && (client.hours || client.hours === 0)) {
      const columnValues = {};
      columnValues[subitemWorkedHoursColumnId] = String(client.hours);
      const columnValuesStr = JSON.stringify(columnValues).replace(/"/g, '\\"');
      columnValuesParam = `column_values: "${columnValuesStr}"`;
    }
    
    const createMutation = `
      mutation {
        create_subitem (
          parent_item_id: ${parentItemId},
          item_name: "${client.clientName || ''}",
          ${columnValuesParam}
        ) {
          id
        }
      }
    `;

    try {
      const result = await callMonday(createMutation);
      const subitemId = result?.create_subitem?.id;
      if (subitemId) {
        createdSubitems.push({
          id: subitemId,
          name: client.clientName || ''
        });
      }
    } catch (error) {
      console.error(`[CRON] Failed to create subitem for client ${client.clientName}:`, error.message);
    }
  }
  
  return createdSubitems;
}

export const fetchBoardColumnsAndGroups = async (boardId) => {
  const query = `
    query {
      boards(ids: ${boardId}) {
        columns {
          id
          title
          type
        }
        groups {
          id
          title
        }
      }
    }
  `
  try {
    const data = await callMonday(query)
    
    if (!data?.boards || data.boards.length === 0) {
      console.error(`[MONDAY ERROR] No boards found for boardId=${boardId}. This might indicate a permissions issue or invalid board ID.`);
      return {
        columns: [],
        groups: []
      }
    }
    
    const board = data.boards[0]
    if (!board) {
      console.error(`[MONDAY ERROR] Board data is null for boardId=${boardId}`);
      return {
        columns: [],
        groups: []
      }
    }
    
    return {
      columns: board.columns || [],
      groups: board.groups || []
    }
  } catch (error) {
    console.error(`[MONDAY ERROR] fetchBoardColumnsAndGroups failed for boardId=${boardId}:`, error);
    return {
      columns: [],
      groups: []
    }
  }
}

export const fetchGroupItems = async (boardId, groupIds, requestedColumnIds, pageLimit = 500) => {
  const allItems = []
  let pageCounter = 0

  const processGroups = (groupsResp, cursorMap) => {
    groupsResp.forEach((g) => {
      if (!g) return
      const groupItems = g.items_page?.items || []
      allItems.push(...groupItems)
      const nextCursor = g.items_page?.cursor || null
      const prevCursor = cursorMap.get(g.id)
      if (nextCursor) {
        if (prevCursor && prevCursor === nextCursor) {
          cursorMap.delete(g.id)
        } else {
          cursorMap.set(g.id, nextCursor)
        }
      } else {
        cursorMap.delete(g.id)
      }
    })
  }

  const cursorMap = new Map()
  const initialQuery = `
    query {
      boards(ids: ${boardId}) {
        groups(ids: [${groupIds.map((id) => `"${id}"`).join(',')}]) {
          id
          title
          items_page(limit: ${pageLimit}) {
            cursor
            items {
              id
              name
              column_values(ids: [${requestedColumnIds}]) {
                id
                text
                value
                ... on PeopleValue {
                  persons_and_teams {
                    id
                    kind
                  }
                }
                ... on TimeTrackingValue {
                  history {
                    started_at
                    ended_at
                    started_user_id
                    ended_user_id
                  }
                }
              }
            }
          }
        }
      }
    }
  `

  const initialData = await callMonday(initialQuery)
  const initialGroups = initialData?.boards?.[0]?.groups || []
  processGroups(initialGroups, cursorMap)

  while (cursorMap.size > 0) {
    if (pageCounter > 1000) {
      break
    }

    for (const [groupId, cursor] of Array.from(cursorMap.entries())) {
      const cursorPart = cursor ? `, cursor: "${cursor}"` : ''
      const pageQuery = `
        query {
          boards(ids: ${boardId}) {
            groups(ids: ["${groupId}"]) {
              id
              title
              items_page(limit: ${pageLimit}${cursorPart}) {
                cursor
                items {
                  id
                  name
                  column_values(ids: [${requestedColumnIds}]) {
                    id
                    text
                    value
                    ... on PeopleValue {
                      persons_and_teams {
                        id
                        kind
                      }
                    }
                    ... on TimeTrackingValue {
                      history {
                        started_at
                        ended_at
                        started_user_id
                        ended_user_id
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `

      const pageData = await callMonday(pageQuery)
      pageCounter += 1
      const groupData = pageData?.boards?.[0]?.groups || []
      processGroups(groupData, cursorMap)
    }
  }

  return allItems
}

const parseIsoToDateString = (iso) => {
  try {
    return new Date(iso).toISOString().substring(0, 10)
  } catch {
    return ''
  }
}

const splitNames = (text) =>
  text
    ? text
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
    : []

export const buildTasksFromItems = (items, columns, dateRange) => {
  const { employee, client, timeTracking1, timeTracking2 } = columns
  
  // Convert date range to milliseconds for easier comparison
  let rangeStartMs = null
  let rangeEndMs = null
  
  if (dateRange?.start) {
    const startDate = new Date(`${dateRange.start}T00:00:00Z`)
    rangeStartMs = startDate.getTime()
  }
  
  if (dateRange?.end) {
    const endDate = new Date(`${dateRange.end}T23:59:59.999Z`)
    rangeEndMs = endDate.getTime()
  }

  // Debug: Check for duplicate items
  const itemIdSet = new Set();
  const duplicateItems = [];
  items.forEach(item => {
    if (itemIdSet.has(item.id)) {
      duplicateItems.push(item.id);
    } else {
      itemIdSet.add(item.id);
    }
  });
  
  // Remove duplicate items, keeping only the first occurrence
  const uniqueItems = [];
  const seenItemIds = new Set();
  items.forEach(item => {
    if (!seenItemIds.has(item.id)) {
      uniqueItems.push(item);
      seenItemIds.add(item.id);
    }
  });
  
  const tasks = []
  const tempNameToId = new Map()
  const tempIdToName = new Map()

  // Pre-pass: build a global map of employee name <-> ID across ALL items,
  // so that time tracking history for an employee is not lost just because
  // their "people" column item appears later in the list. This mirrors the
  // frontend TaskTimeDashboard logic.
  uniqueItems.forEach((item) => {
    const columnsValues = item.column_values || []
    const employeeCol = columnsValues.find((col) => col.id === employee)
    if (!employeeCol) return

    const employeeText = employeeCol.text || ''
    const employeeNames = splitNames(employeeText)

    if (Array.isArray(employeeCol.persons_and_teams)) {
      const persons = employeeCol.persons_and_teams.filter((p) => p.kind === 'person' && p.id)
      persons.forEach((person, index) => {
        const name = employeeNames[index] || ''
        if (name) {
          tempNameToId.set(name, person.id)
          tempIdToName.set(String(person.id), name)
        }
      })
      if (employeeNames.length > persons.length) {
        employeeNames.slice(persons.length).forEach((name) => {
          if (name && !tempNameToId.has(name)) {
            tempNameToId.set(name, '')
          }
        })
      }
    } else {
      employeeNames.forEach((name) => {
        if (name && !tempNameToId.has(name)) {
          tempNameToId.set(name, '')
        }
      })
    }
  })

  uniqueItems.forEach((item) => {
    const columnsValues = item.column_values || []
    const employeeCol = columnsValues.find((col) => col.id === employee)

    if (!employeeCol) {
      return
    }

    const employeeText = employeeCol.text || ''
    const employeeNames = splitNames(employeeText)
    const employeeIds = []

    if (Array.isArray(employeeCol.persons_and_teams)) {
      const persons = employeeCol.persons_and_teams.filter((p) => p.kind === 'person' && p.id)
      persons.forEach((person, index) => {
        const name = employeeNames[index] || ''
        if (name) {
          tempNameToId.set(name, person.id)
          tempIdToName.set(String(person.id), name)
        }
        employeeIds.push(person.id)
      })
      if (employeeNames.length > persons.length) {
        employeeNames.slice(persons.length).forEach((name) => tempNameToId.set(name, ''))
      }
    }

    const clientCol = columnsValues.find((col) => col.id === client)
    const clientValue = clientCol?.text || ''

    const employeeTimeMap = new Map()
    let taskDate = ''

    const processTimeHistory = (timeCol, colName) => {
      if (!timeCol?.history || !Array.isArray(timeCol.history)) {
        return
      }
      
      // Track processed entries to avoid duplicates
      const processedEntries = new Set()
      
      timeCol.history.forEach((entry, index) => {
        // Create a unique key for this entry to avoid duplicates
        const entryKey = `${entry.started_at}_${entry.ended_at}_${entry.started_user_id}_${entry.ended_user_id}`
        
        if (processedEntries.has(entryKey)) {
          return
        }
        processedEntries.add(entryKey)

        // Be tolerant of missing started_at / ended_at, same as frontend logic:
        // - Use whichever timestamp is present as both start and end as a fallback,
        //   so that entries with only one side set are still counted.
        let startIso = entry.started_at || entry.ended_at
        let endIso = entry.ended_at || entry.started_at
        const userId = entry.started_user_id || entry.ended_user_id

        // Skip entries without timestamps or user
        if (!startIso || !endIso || !userId) {
          return
        }

        try {
          const startTime = new Date(startIso).getTime()
          const endTime = new Date(endIso).getTime()

          // Validate time range
          if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
            return
          }

          // If we have a date range filter, only count time within that range
          if (rangeStartMs !== null && rangeEndMs !== null) {
            // Entry is completely outside the range
            if (endTime < rangeStartMs || startTime > rangeEndMs) {
              return
            }
            
            // Calculate overlapping portion
            const clampedStart = Math.max(startTime, rangeStartMs)
            const clampedEnd = Math.min(endTime, rangeEndMs)
            
            // Ensure valid overlap
            if (clampedEnd <= clampedStart) {
              return
            }
            
            const durationMs = clampedEnd - clampedStart
            const durationMinutes = Math.floor(durationMs / (1000 * 60))
            
            if (durationMinutes > 0) {
              const currentTime = employeeTimeMap.get(userId) || 0
              employeeTimeMap.set(userId, currentTime + durationMinutes)
              if (!taskDate) {
                taskDate = parseIsoToDateString(new Date(clampedStart))
              }
            }
          } else {
            // No date range filter, count full duration
            const durationMs = endTime - startTime
            const durationMinutes = Math.floor(durationMs / (1000 * 60))
            
            if (durationMinutes > 0) {
              const currentTime = employeeTimeMap.get(userId) || 0
              employeeTimeMap.set(userId, currentTime + durationMinutes)
              if (!taskDate) {
                taskDate = parseIsoToDateString(new Date(startTime))
              }
            }
          }
        } catch (err) {
          // Silently skip invalid entries
        }
      })
    }

    const timeCol1 = columnsValues.find((col) => col.id === timeTracking1)
    const timeCol2 = columnsValues.find((col) => col.id === timeTracking2)
    
    if (timeCol1) processTimeHistory(timeCol1, 'timeTracking1')
    if (timeCol2) processTimeHistory(timeCol2, 'timeTracking2')

    const allEmployeeEntries = new Map()
    
    // First, populate from employee names in the employee column
    employeeNames.forEach((name, index) => {
      const empId = employeeIds[index] || tempNameToId.get(name) || ''
      // Use employee ID as the key if available, otherwise use name
      const key = empId || name || `emp-${index}`
      allEmployeeEntries.set(key, {
        name,
        id: empId
      })
    })

    // Then, add any employees from time tracking that aren't already in the list
    employeeTimeMap.forEach((_time, empId) => {
      // Only add if this employee isn't already in our list
      const empIdStr = String(empId)
      
      // Check if employee with this ID already exists
      // We need to check if any existing employee has this ID (and the ID is not empty)
      const alreadyExists = Array.from(allEmployeeEntries.values()).some(emp => emp.id === empIdStr && emp.id !== '');
      
      if (!alreadyExists && tempIdToName.has(empIdStr)) {
        const empName = tempIdToName.get(empIdStr);
        // Use employee ID as the key
        allEmployeeEntries.set(empIdStr, { name: empName, id: empIdStr });
      }
    })

    const employeeList = Array.from(allEmployeeEntries.values())
    const monthKey = taskDate ? taskDate.substring(0, 7) : dateRange?.start?.substring(0, 7) || ''

    if (employeeList.length > 0 && employeeTimeMap.size > 0) {
      employeeList.forEach((emp) => {
        const empTimeMinutes = emp.id && employeeTimeMap.has(emp.id) ? employeeTimeMap.get(emp.id) : 0
        if (empTimeMinutes <= 0) {
          return
        }
        const effectiveDate = taskDate || dateRange?.start || ''
        tasks.push({
          id: item.id,
          task: item.name || '',
          employee: emp.name || '',
          employeeId: emp.id || '',
          client: clientValue,
          date: effectiveDate,
          month: monthKey,
          timeMinutes: empTimeMinutes
        })
      })
    }
  })
  
  return tasks
}


// Nested aggregation: one object per employee.
// Final shape example:
// {
//   employeeName: "Shan Ali",
//   employeeId: "97317609",
//   "sd no-billable client": 1,
//   "the dash": 1.67,
//   "simpleday": 1,
//   // Only truly "other" clients (non sd/dash/simpleday) – kept for backwards compatibility
//   otherClients: [ ... ],
//   // NEW: allClients contains *every* client (sd/dash/simpleday/other) with hours
//   // and is used for creating subitems on the target board.
//   allClients: [ ... ],
//   totalWorkedHours: 13.07,
//   totalClientHours: 9.4
// }
export const aggregateTasksByEmployeeClientMonth = (tasks) => {
  // Internal map: employeeId or name -> aggregation buckets
  const employeeMap = new Map();
  
  // Debug: Log the number of tasks being processed
  
  tasks.forEach((task, index) => {
    // Debug: Log each task being processed
    console.log(`[AGGREGATION DEBUG] Processing task ${index}:`, {
      employee: task.employee,
      employeeId: task.employeeId,
      client: task.client,
      timeMinutes: task.timeMinutes,
      month: task.month
    });
    
    const empKey = task.employeeId || task.employee;
    if (!employeeMap.has(empKey)) {
      employeeMap.set(empKey, {
        employeeName: task.employee,
        employeeId: task.employeeId,
        sdClients: [],
        dashClients: [],
        simpledayClients: [],
        otherClients: [],
        totalWorkedHours: 0,
        totalClientHours: 0
      });
    }
    const empObj = employeeMap.get(empKey);

    // Determine client type
    let type = 'other';
    const clientLower = (task.client || '').toLowerCase();
    if (clientLower.includes('dash')) type = 'dash';
    else if (clientLower.includes('simple day') || clientLower.includes('simpleday')) type = 'simpleday';
    else if (clientLower.includes('sd')) type = 'sd';

    // Add client to the correct array
    const clientObj = {
      clientName: task.client,
      clientId: task.clientId || '',
      month: task.month,
      minutes: task.timeMinutes || 0
    };
    if (type === 'sd') empObj.sdClients.push(clientObj);
    else if (type === 'dash') empObj.dashClients.push(clientObj);
    else if (type === 'simpleday') empObj.simpledayClients.push(clientObj);
    else empObj.otherClients.push(clientObj);

    // Add to totalWorkedHours once per task (includes ALL time tracked)
    empObj.totalWorkedHours += task.timeMinutes || 0;
    
    // Only add to totalClientHours for "other" clients
    // Prevent double counting by ensuring we only count once
    if (type === 'other') {
      empObj.totalClientHours += task.timeMinutes || 0;
    }
  });
  // Merge duplicate clients (same name/month) in each array and sum minutes
  const mergeClients = (clients) => {
    const map = new Map();
    clients.forEach(c => {
      const key = `${c.clientName}__${c.month}`;
      if (!map.has(key)) {
        map.set(key, { ...c });
      } else {
          map.get(key).minutes += c.minutes;
      }
    });
      // Convert minutes to hours (rounded to 2 decimals)
      return Array.from(map.values()).map(c => ({
        ...c,
        hours: Math.round((c.minutes / 60) * 100) / 100 
      }));
  };

  const aggregatedResults = Array.from(employeeMap.values()).map(emp => {
    const result = {
      employeeName: emp.employeeName,
      employeeId: emp.employeeId
    };

    // Merge and convert sd / dash / simpleday clients, then flatten them
    const mergedSdClients = mergeClients(emp.sdClients);
    const mergedDashClients = mergeClients(emp.dashClients);
    const mergedSimpledayClients = mergeClients(emp.simpledayClients);

    const allTypedClients = [
      ...mergedSdClients,
      ...mergedDashClients,
      ...mergedSimpledayClients
    ];

    allTypedClients.forEach(c => {
      const prev = result[c.clientName] || 0;
      // Sum hours if same client name appears multiple times
      result[c.clientName] = Math.round((prev + c.hours) * 100) / 100;
    });

    // keep "otherClients" as an array of objects with hours field (backwards compatible)
    const mergedOtherClients = mergeClients(emp.otherClients);
    result.otherClients = mergedOtherClients;

    // NEW: allClients = every client (typed + other) with hours.
    // This will be used to create subitems for *all* clients on the board.
    result.allClients = [
      ...mergedSdClients,
      ...mergedDashClients,
      ...mergedSimpledayClients,
      ...mergedOtherClients
    ];
    result.totalWorkedHours = Math.round((emp.totalWorkedHours / 60) * 100) / 100;
    result.totalClientHours = Math.round((emp.totalClientHours / 60) * 100) / 100;

    return result;
  });
  
  return aggregatedResults;
}

// Update subitem worked hours column for an employee
export const updateEmployeeSubitemWorkedHours = async (targetConfig, employeeSummary, monthKey) => {
  // Get the employee's group ID from the target config
  // Try to find the group using employeeId first, then employeeName
  let groupId = null;
  
  // Handle both Map and plain object structures
  const employeeGroups = targetConfig.employeeGroups;
  
  if (employeeSummary.employeeId) {
    // Try Map.get() first
    if (employeeGroups instanceof Map && employeeGroups.get(employeeSummary.employeeId)) {
      groupId = employeeGroups.get(employeeSummary.employeeId);
    } 
    // Try plain object access
    else if (employeeGroups?.[employeeSummary.employeeId]) {
      groupId = employeeGroups[employeeSummary.employeeId];
    }
  }
  
  if (!groupId && employeeSummary.employeeName) {
    // Try Map.get() for employeeName
    if (employeeGroups instanceof Map && employeeGroups.get(employeeSummary.employeeName)) {
      groupId = employeeGroups.get(employeeSummary.employeeName);
    }
    // Try plain object access for employeeName
    else if (employeeGroups?.[employeeSummary.employeeName]) {
      groupId = employeeGroups[employeeSummary.employeeName];
    }
  }
  
  // Try to find any key that matches
  if (!groupId) {
    // For Map
    if (employeeGroups instanceof Map) {
      for (const [key, value] of employeeGroups) {
        if (key === String(employeeSummary.employeeId) || key === employeeSummary.employeeName) {
          groupId = value;
          break;
        }
      }
    }
    // For plain object
    else {
      for (const [key, value] of Object.entries(employeeGroups || {})) {
        if (key === String(employeeSummary.employeeId) || key === employeeSummary.employeeName) {
          groupId = value;
          break;
        }
      }
    }
  }
  
  if (!groupId) {
    return;
  }
  
  // Get or create the month item for this employee
  const boardId = targetConfig.targetBoardId;
  const itemId = await getOrCreateMonthItem(boardId, groupId, monthKey);
  
  if (!itemId) {
    console.log(`[CRON] Could not get or create month item for ${employeeSummary.employeeName}`);
    return;
  }
  
  // For each client, create subitems.
  // Prefer the new allClients array; fall back to otherClients for backwards compatibility.
  const clientsForSubitems = employeeSummary.allClients || employeeSummary.otherClients || [];
  
  console.log(`[CRON DEBUG] Processing ${clientsForSubitems.length} clients for subitems for ${employeeSummary.employeeName}`);
  
  if (clientsForSubitems.length === 0) {
    console.log(`[CRON] No clients to process for subitems for ${employeeSummary.employeeName}`);
    return;
  }
  
  // Sync the subitems (create new ones, archive old ones) with worked hours column values set during creation.
  // Note: we reuse the generic syncOtherClientsAsSubitems helper, but we now pass ALL clients.
  const createdSubitems = await syncOtherClientsAsSubitems({ 
    parentItemId: itemId,
    otherClients: clientsForSubitems,
    subitemWorkedHoursColumnId: targetConfig.subitemWorkedHoursColumnId 
  });
  
}

// Create items and subitems on target board based on configuration and data
export const createTargetBoardItems = async (targetConfig, employeeSummaries, monthKey) => {
  if (!targetConfig || !employeeSummaries || !Array.isArray(employeeSummaries)) {
    return;
  }
  
  const boardId = targetConfig.targetBoardId;
  
  // Process each employee summary
  for (const employeeSummary of employeeSummaries) {
    try {
      // Get the employee's group ID from the target config
      let groupId = null;
      const employeeGroups = targetConfig.employeeGroups;
      
      if (employeeSummary.employeeId) {
        if (employeeGroups instanceof Map && employeeGroups.get(employeeSummary.employeeId)) {
          groupId = employeeGroups.get(employeeSummary.employeeId);
        } else if (employeeGroups?.[employeeSummary.employeeId]) {
          groupId = employeeGroups[employeeSummary.employeeId];
        }
      }
      
      if (!groupId && employeeSummary.employeeName) {
        if (employeeGroups instanceof Map && employeeGroups.get(employeeSummary.employeeName)) {
          groupId = employeeGroups.get(employeeSummary.employeeName);
        } else if (employeeGroups?.[employeeSummary.employeeName]) {
          groupId = employeeGroups[employeeSummary.employeeName];
        }
      }
      
      if (!groupId) {
        continue;
      }
      
      // Get or create the month item for this employee
      const itemId = await getOrCreateMonthItem(boardId, groupId, monthKey);
      if (!itemId) {
        continue;
      }
      
      // Update the main item with employee data
      const columnTypes = {}; // TODO: Get actual column types if needed
      
      // Get the column mapping for this group
      let clientColumnMap = {};
      if (targetConfig.groupClientColumns instanceof Map) {
        clientColumnMap = targetConfig.groupClientColumns.get(groupId) || {};
      } else {
        clientColumnMap = targetConfig.groupClientColumns?.[groupId] || {};
      }
      
      await updateMonthRowForEmployee({
        boardId,
        groupId,
        monthKey,
        employeeSummary,
        clientColumnMap,
        totalWorkedHoursColumnId: targetConfig.totalWorkedHoursColumnId,
        totalClientHoursColumnId: targetConfig.totalClientHoursColumnId,
        columnTypes
      });
      
      // Create subitems for clients if configured.
      // Prefer allClients (new), but keep support for otherClients for older data.
      const hasAnyClientsForSubitems =
        (Array.isArray(employeeSummary.allClients) && employeeSummary.allClients.length > 0) ||
        (Array.isArray(employeeSummary.otherClients) && employeeSummary.otherClients.length > 0);

      if (targetConfig.subitemWorkedHoursColumnId && hasAnyClientsForSubitems) {
        await updateEmployeeSubitemWorkedHours(targetConfig, employeeSummary, monthKey);
      }
      
      console.log(`[TARGET BOARD] Successfully processed employee ${employeeSummary.employeeName}`);
    } catch (error) {
      console.error(`[TARGET BOARD] Error processing employee ${employeeSummary.employeeName}:`, error.message);
    }
  }
  
  console.log('[TARGET BOARD] Finished processing all employees');
}
