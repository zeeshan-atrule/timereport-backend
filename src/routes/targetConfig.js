import { Router } from 'express'
import TargetBoardConfig from '../models/TargetBoardConfig.js'

const router = Router()

// Get target-board configuration for a given source board
router.get('/:sourceBoardId', async (req, res, next) => {
  try {
    const sourceBoardId = Number(req.params.sourceBoardId)
    const config = await TargetBoardConfig.findOne({ sourceBoardId })
    if (!config) {
      return res.status(404).json({ message: 'Target board configuration not found' })
    }
    res.json(config)
  } catch (err) {
    next(err)
  }
})

// Create/update target-board configuration for a given source board
// Body: {
//   boardId,
//   employeeGroups,
//   groupClientColumns,
//   totalWorkedHoursColumnId,
//   totalClientHoursColumnId
// }
router.post('/:sourceBoardId', async (req, res, next) => {
  try {
    const sourceBoardId = Number(req.params.sourceBoardId)
    let {
      boardId,
      employeeGroups,
      groupClientColumns,
      totalWorkedHoursColumnId,
      totalClientHoursColumnId,
      subitemWorkedHoursColumnId // new
    } = req.body || {}

    if (!boardId) {
      return res.status(400).json({ message: 'target boardId is required' })
    }

    // Handle global client column mapping
    // If we have a __global key, apply those mappings to all employee groups
    if (groupClientColumns?.__global) {
      console.log('[CONFIG] Converting global client column mapping to per-group mapping');
      
      // Get the actual group IDs from employeeGroups
      const groupIds = Object.values(employeeGroups || {}).filter(Boolean);
      console.log('[CONFIG] Group IDs:', groupIds);
      
      // For each group, apply the global mappings
      const convertedGroupClientColumns = {};
      for (const groupId of groupIds) {
        convertedGroupClientColumns[groupId] = { ...groupClientColumns.__global };
      }
      
      groupClientColumns = convertedGroupClientColumns;
      console.log('[CONFIG] Converted groupClientColumns:', groupClientColumns);
    }

    const config = await TargetBoardConfig.findOneAndUpdate(
      { sourceBoardId },
      {
        $set: {
          sourceBoardId,
          targetBoardId: Number(boardId),
          employeeGroups: employeeGroups || {},
          groupClientColumns: groupClientColumns || {},
          totalWorkedHoursColumnId: totalWorkedHoursColumnId || null,
          totalClientHoursColumnId: totalClientHoursColumnId || null,
          subitemWorkedHoursColumnId: subitemWorkedHoursColumnId || null // new
        }
      },
      { upsert: true, new: true }
    )

    res.json(config)
  } catch (err) {
    next(err)
  }
})

export default router


