import cron from 'node-cron'
import Configuration from './models/Configuration.js'
import MonthlyReport from './models/MonthlyReport.js'
import TargetBoardConfig from './models/TargetBoardConfig.js'
import { fetchGroupItems, buildTasksFromItems, updateMonthRowForEmployee, updateEmployeeSubitemWorkedHours, createTargetBoardItems } from './services/monday.js'

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

// Core job logic shared by both schedules
const runMonthlyReportJob = async (triggerSource = 'manual') => {
  // Prevent multiple simultaneous executions
  if (isCronJobRunning) {
    console.log('[CRON] Monthly report job already running, skipping. Trigger:', triggerSource)
    return
  }

  isCronJobRunning = true;
  console.log('[CRON] Monthly report job started. Trigger:', triggerSource, 'at', new Date().toISOString());

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
      console.log('[CRON DEBUG] Target groups for board', boardId, ':', targetGroups);
      if (!targetGroups || targetGroups.length === 0) {
        console.log('[CRON DEBUG] No target groups found, skipping board', boardId);
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
      console.log('[CRON DEBUG] Requested column IDs:', requestedColumnIds);
      const items = await fetchGroupItems(boardId, targetGroups, requestedColumnIds, 500)
      console.log('[CRON DEBUG] Items fetched from Monday - count:', items.length);
      console.log('[CRON DEBUG] Building tasks from items with columns:', config.columns);
      const rawTasks = buildTasksFromItems(items, config.columns, { start: monthRange.start, end: monthRange.end });
      console.log('[CRON DEBUG] Raw tasks count after buildTasksFromItems:', rawTasks.length);
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
      console.log(`[CRON] Synced monthly report for board ${boardId}, month ${monthRange.key}`)
      
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
    }
  } catch (err) {
    console.error('[CRON] Error syncing monthly reports:', err)
  } finally {
    // Reset the flag when the job completes (success or failure)
    isCronJobRunning = false;
    console.log('[CRON] Monthly report job completed at:', new Date().toISOString(), 'Trigger:', triggerSource);
  }
}

export const startMonthlyReportCron = () => {
  // Existing high-frequency cron (for testing) – currently every minute
  cron.schedule('*/1 * * * *', async () => {
    await runMonthlyReportJob('cron-every-minute')
  })

  // New production-like cron: run every day at 00:00 server time,
  // but only execute logic if it's the last day of the month
  cron.schedule('0 0 * * *', async () => {
    if (!isLastDayOfMonth()) {
      console.log('[CRON] Midnight daily check – not last day of month, skipping job')
      return
    }

    await runMonthlyReportJob('cron-last-day-midnight')
  })
}
