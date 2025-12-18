import { Router } from 'express'
import Configuration from '../models/Configuration.js'

const router = Router()

router.get('/:boardId', async (req, res, next) => {
  try {
    const boardId = Number(req.params.boardId)
    const config = await Configuration.findOne({ boardId })
    if (!config) {
      return res.status(404).json({ message: 'Configuration not found' })
    }
    res.json(config)
  } catch (err) {
    next(err)
  }
})

router.post('/:boardId', async (req, res, next) => {
  try {
    const boardId = Number(req.params.boardId)
    const { columns, groupConfig } = req.body

    if (!columns?.employee || !columns?.client || !columns?.timeTracking1 || !columns?.timeTracking2) {
      return res.status(400).json({ message: 'Missing required columns' })
    }

    const config = await Configuration.findOneAndUpdate(
      { boardId },
      { $set: { columns, groupConfig: groupConfig || {} } },
      { upsert: true, new: true }
    )

    res.json(config)
  } catch (err) {
    next(err)
  }
})

export default router


