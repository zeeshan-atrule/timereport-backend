import cron from 'node-cron'
import Configuration from './models/Configuration.js'
import MonthlyReport from './models/MonthlyReport.js'
import TargetBoardConfig from './models/TargetBoardConfig.js'
import { fetchGroupItems, buildTasksFromItems, updateMonthRowForEmployee, updateEmployeeSubitemWorkedHours, createTargetBoardItems, fetchBoardColumnsAndGroups } from './services/monday.js'
import { decrypt } from './utils/crypto.js'
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

const isLastDayOfMonth = () => {
  const today = new Date()
  const tomorrow = new Date(today)
  tomorrow.setDate(today.getDate() + 1)
  return today.getMonth() !== tomorrow.getMonth()
}

let isCronJobRunning = false;

// === CHANGE: Accept apiToken parameter ===
const updateAllMonthsGroupConfig = async (config, apiToken) => {
// ===================================
  try {
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    
    // === PASS TOKEN TO FETCH FUNCTION ===
    const { groups } = await fetchBoardColumnsAndGroups(config.boardId, apiToken);
    // =================================
    
    if (groups.length === 0) {
      return;
    }
    
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
    
    const groupConfigObj = config.groupConfig instanceof Map
      ? Object.fromEntries(config.groupConfig)
      : config.groupConfig || {};
    
    const allMonthKeys = Object.keys(groupConfigObj);
    
    let updatedCount = 0;
    let needsSave = false;
    
    for (const monthKey of allMonthKeys) {
      const currentGroups = groupConfigObj[monthKey] || [];
      
      if (!Array.isArray(currentGroups) || currentGroups.length === 0) {
        continue;
      }
      
      const monthGroup = monthGroupMap.get(monthKey);
      
      if (!monthGroup) {
        continue;
      }
      
      const groupMap = new Map(groups.map(g => [g.id, g.title]));
      
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
      
      if (monthGroupIdToReplace) {
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
      } else if (!currentGroups.includes(monthGroup.id)) {
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
    
    if (needsSave) {
      await config.save();
    }
  } catch (err) {
    console.error(`[GROUP UPDATE] Error updating group config for board ${config.boardId}:`, err);
  }
};

export const runMonthlyReportJob = async (triggerSource = 'manual') => {
  if (isCronJobRunning) {
    return
  }

  isCronJobRunning = true;

  try {
    const configs = await Configuration.find({})
    for (const config of configs) {
      const boardId = config.boardId
      const monthRange = getCurrentMonthRange()
      
      // === EXTRACT TOKEN FROM CONFIG ===
      const apiToken = config.apiToken ? decrypt(config.apiToken) : null;
      
      // Check if token exists
      if (!apiToken) {
        console.error(`[CRON] No API Token found in configuration for board ${boardId}. Skipping.`);
        continue;
      }
      // ==================================
      
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
      
      // === PASS TOKEN TO FETCH ITEMS ===
      const items = await fetchGroupItems(boardId, targetGroups, requestedColumnIds, 500, apiToken)
      // ===============================
      
      const rawTasks = buildTasksFromItems(items, config.columns, { start: monthRange.start, end: monthRange.end });
      
      const mod = await import('./services/monday.js')
      const tasks = mod.aggregateTasksByEmployeeClientMonth(rawTasks)
      
      await MonthlyReport.deleteOne({ boardId, monthKey: monthRange.key })
      await MonthlyReport.create({
        boardId,
        monthKey: monthRange.key,
        monthName: monthRange.name,
        tasks,
        generatedAt: new Date()
      })
      
      if (targetConfig) {
        const monthlyReport = await MonthlyReport.findOne({ boardId, monthKey: monthRange.key })
        if (monthlyReport && Array.isArray(monthlyReport.tasks)) {
          const monthLabel = monthlyReport.monthName || monthRange.name || monthRange.key
          
          // === PASS TOKEN TO CREATE TARGET ITEMS ===
          await createTargetBoardItems(targetConfig, monthlyReport.tasks, monthLabel, apiToken);
          // ======================================
        }
      }
      
      // === PASS TOKEN TO UPDATE GROUP CONFIG ===
      await updateAllMonthsGroupConfig(config, apiToken);
      // =======================================
    }
  } catch (err) {
    console.error('[CRON] Error syncing monthly reports:', err)
  } finally {
    isCronJobRunning = false;
  }
}
