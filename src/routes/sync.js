import { Router } from 'express'
import Configuration from '../models/Configuration.js'
import MonthlyReport from '../models/MonthlyReport.js'
import { fetchGroupItems, buildTasksFromItems } from '../services/monday.js'

const router = Router()

const getCurrentMonthRange = () => {
  const now = new Date()
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const start = new Date(Date.UTC(year, month, 1))
  const end = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999))
  const toStr = (d) => d.toISOString().substring(0, 10)
  return { start: toStr(start), end: toStr(end), key: `${year}-${String(month + 1).padStart(2, '0')}` }
}

router.post('/:boardId', async (req, res, next) => {
  try {
    const boardId = Number(req.params.boardId)
    const config = await Configuration.findOne({ boardId })
    if (!config) {
      return res.status(404).json({ message: 'Configuration not found' })
    }

    const monthRange = getCurrentMonthRange()
    const targetGroups = config.groupConfig?.get
      ? config.groupConfig.get(monthRange.key)
      : config.groupConfig?.[monthRange.key]

    if (!targetGroups || targetGroups.length === 0) {
      return res.status(400).json({ message: `No groups configured for ${monthRange.key}` })
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
    const rawTasks = buildTasksFromItems(items, config.columns, { start: monthRange.start, end: monthRange.end })
    // Aggregate tasks by employee, month, client
    const { aggregateTasksByEmployeeMonthClient } = await import('../services/monday.js')
    const tasks = aggregateTasksByEmployeeMonthClient(rawTasks)

    const report = await MonthlyReport.findOneAndUpdate(
      { boardId, monthKey: monthRange.key },
      { $set: { tasks, generatedAt: new Date() } },
      { upsert: true, new: true }
    )

    res.json({
      boardId,
      monthKey: monthRange.key,
      taskCount: tasks.length,
      report
    })
  } catch (err) {
    next(err)
  }
})

router.get('/:boardId/:monthKey', async (req, res, next) => {
  try {
    const boardId = Number(req.params.boardId)
    const { monthKey } = req.params
    const report = await MonthlyReport.findOne({ boardId, monthKey })
    if (!report) {
      return res.status(404).json({ message: 'Report not found' })
    }
    res.json(report)
  } catch (err) {
    next(err)
  }
})

export default router


