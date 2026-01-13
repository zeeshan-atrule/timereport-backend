import cron from 'node-cron'
import Configuration from './models/Configuration.js'
import MonthlyReport from './models/MonthlyReport.js'
import TargetBoardConfig from './models/TargetBoardConfig.js'
import { fetchGroupItems, buildTasksFromItems, updateMonthRowForEmployee, updateEmployeeSubitemWorkedHours, createTargetBoardItems, fetchBoardColumnsAndGroups } from './services/monday.js'

const getCurrentMonthRange = () => {
  const now = new Date()
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const start = new Date(Date.UTC(year, month, 1))
  const end = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999))
  const toStr = (d) => d.toISOString().substring(0, 10)

  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
  ]

  const key = `${year}-${String(month + 1).padStart(2, '0')}`
  const name = `${monthNames[month]} ${year}`

  return { start: toStr(start), end: toStr(end), key, name }
}

// Helper: check if "today" is the last calendar day of the current month
const isLastDayOfMonth = () => {
  const today = new Date()
  const tomorrow = new Date(today)
  tomorrow.setDate(today.getDate() + 1)
  return today.getMonth() !== tomorrow.getMonth()
}

let isCronJobRunning = false;

// Function to update group configuration for all months
// It finds groups matching month names (e.g., "January 2026", "December 2025")
// and updates them in the configuration while keeping other groups unchanged
const updateAllMonthsGroupConfig = async (config) => {
  try {
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    
    // Fetch all groups from Monday.com board (only once)
    const { groups } = await fetchBoardColumnsAndGroups(config.boardId);
    
    if (groups.length === 0) {
      return;
    }
    
    // Create a map of month names to group IDs (e.g., "January 2026" -> "group_id")
    const monthGroupMap = new Map();
    const monthNamePattern = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/;
    
    groups.forEach(group => {
      const match = group.title.match(monthNamePattern);
      if (match) {
        const monthName = match[1];
        const year = parseInt(match[2]);
        const monthIndex = monthNames.indexOf(monthName);
        if (monthIndex !== -1) {
          const monthKey = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
          monthGroupMap.set(monthKey, group);
        }
      }
    });
    
    // Get all month keys from configuration
    const groupConfigObj = config.groupConfig instanceof Map
      ? Object.fromEntries(config.groupConfig)
      : config.groupConfig || {};
    
    const allMonthKeys = Object.keys(groupConfigObj);
    
    let updatedCount = 0;
    let needsSave = false;
    
    // Process each month in the configuration
    for (const monthKey of allMonthKeys) {
      const currentGroups = groupConfigObj[monthKey] || [];
      
      if (!Array.isArray(currentGroups) || currentGroups.length === 0) {
        continue;
      }
      
      // Find the month group for this month key
      const monthGroup = monthGroupMap.get(monthKey);
      
      if (!monthGroup) {
        continue;
      }
      
      // Create a map of group IDs to titles for current groups
      const groupMap = new Map(groups.map(g => [g.id, g.title]));
      
      // Find which of the current groups matches a month name pattern
      let monthGroupIdToReplace = null;
      const otherGroups = [];
      
      for (const groupId of currentGroups) {
        const groupTitle = groupMap.get(groupId);
        if (groupTitle && monthNamePattern.test(groupTitle)) {
          monthGroupIdToReplace = groupId;
        } else {
          otherGroups.push(groupId);
        }
      }
      
      // If we found a month-named group to replace, update it
      if (monthGroupIdToReplace) {
        const updatedGroups = [...otherGroups, monthGroup.id];
        
        // Update the configuration
        if (config.groupConfig instanceof Map) {
          config.groupConfig.set(monthKey, updatedGroups);
        } else {
          if (!config.groupConfig) {
            config.groupConfig = {};
          }
          config.groupConfig[monthKey] = updatedGroups;
        }
        
        updatedCount++;
        needsSave = true;
      } else if (!currentGroups.includes(monthGroup.id)) {
        // If no month-named group found but month group is not in the list, add it
        const updatedGroups = [...otherGroups, monthGroup.id];
        
        if (config.groupConfig instanceof Map) {
          config.groupConfig.set(monthKey, updatedGroups);
        } else {
          if (!config.groupConfig) {
            config.groupConfig = {};
          }
          config.groupConfig[monthKey] = updatedGroups;
        }
        
        updatedCount++;
        needsSave = true;
      }
    }
    
    // Save configuration if any updates were made
    if (needsSave) {
      await config.save();
    }
  } catch (err) {
    console.error(`[GROUP UPDATE] Error updating group config for board ${config.boardId}:`, err);
    // Don't throw - we don't want to break the main cron job if group update fails
  }
};

// Core job logic shared by both schedules
export const runMonthlyReportJob = async (triggerSource = 'manual') => {
  // Prevent multiple simultaneous executions
  if (isCronJobRunning) {
    return
  }

  isCronJobRunning = true;

  try {
    const configs = await Configuration.find({})
    for (const config of configs) {
      const boardId = config.boardId
      const monthRange = getCurrentMonthRange()
      
      // Fetch target board config for subitem columns
      const targetConfig = await TargetBoardConfig.findOne({ sourceBoardId: boardId })
      const targetGroups = config.groupConfig?.get
        ? config.groupConfig.get(monthRange.key)
        : config.groupConfig?.[monthRange.key]
      if (!targetGroups || targetGroups.length === 0) {
        continue;
      }
      const requestedColumnIds = [
        config.columns.employee,
        config.columns.client,
        config.columns.timeTracking1,
        config.columns.timeTracking2
      ]
        .filter(Boolean)
        .map((id) => `"${id}"`)
        .join(',')
      const items = await fetchGroupItems(boardId, targetGroups, requestedColumnIds, 500)
      const rawTasks = buildTasksFromItems(items, config.columns, { start: monthRange.start, end: monthRange.end });
      const mod = await import('./services/monday.js')
      const tasks = mod.aggregateTasksByEmployeeClientMonth(rawTasks)
      // Delete previous report for this board and month
      await MonthlyReport.deleteOne({ boardId, monthKey: monthRange.key })
      // Insert new report
      await MonthlyReport.create({
        boardId,
        monthKey: monthRange.key,
        monthName: monthRange.name,
        tasks,
        generatedAt: new Date()
      })
      
      // Update the target board with items and subitems
      if (targetConfig) {
        const monthlyReport = await MonthlyReport.findOne({ boardId, monthKey: monthRange.key })
        if (monthlyReport && Array.isArray(monthlyReport.tasks)) {
          // Use monthName (e.g. "December 2025") on the board; fall back to monthKey if not present
          const monthLabel = monthlyReport.monthName || monthRange.name || monthRange.key
          // Use the new consolidated function to create items and subitems
          await createTargetBoardItems(targetConfig, monthlyReport.tasks, monthLabel);
        }
      }
      
      // Update group configuration for all months
      // This finds groups matching month names and updates them in the configuration
      await updateAllMonthsGroupConfig(config);
    }
  } catch (err) {
    console.error('[CRON] Error syncing monthly reports:', err)
  } finally {
    // Reset the flag when the job completes (success or failure)
    isCronJobRunning = false;
  }
}

// export const startMonthlyReportCron = () => {
//   // Existing high-frequency cron (for testing) – currently every minute
//   cron.schedule('*/1 * * * *', async () => {
//     await runMonthlyReportJob('cron-every-minute')
//   })

//   // New production-like cron: run every day at 00:00 server time,
//   // but only execute logic if it's the last day of the month
//   cron.schedule('0 0 * * *', async () => {
//     if (!isLastDayOfMonth()) {
//       console.log('[CRON] Midnight daily check – not last day of month, skipping job')
//       return
//     }

//     await runMonthlyReportJob('cron-last-day-midnight')
//   })
// }
