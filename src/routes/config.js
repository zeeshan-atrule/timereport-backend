import { Router } from 'express'
import Configuration from '../models/Configuration.js'
import { encrypt, decrypt } from '../utils/crypto.js'

const router = Router()

router.get('/:boardId', async (req, res, next) => {
  try {
    const boardId = Number(req.params.boardId)
    const config = await Configuration.findOne({ boardId })
    if (!config) {
      return res.status(404).json({ message: 'Configuration not found' })
    }
    const decryptedToken = config.apiToken ? decrypt(config.apiToken) : null;
     const configForFrontend = {
      ...config.toObject(),  // Mongoose document → plain JS object
      apiToken: decryptedToken // replace encrypted token with decrypted token
    }
    res.json(configForFrontend)
  } catch (err) {
    next(err)
  }
})
router.get('/', async (req, res, next) => {
  try {
    const { includeToken } = req.query; // ?includeToken=true

    const configs = await Configuration.find().sort({ boardId: 1 });

    const configsForFrontend = configs.map(config => {
      const obj = config.toObject();

      return {
        ...obj,
        apiToken:
          includeToken === 'true' && obj.apiToken
            ? decrypt(obj.apiToken)
            : undefined // hide token by default
      };
    });

    res.json({
      success: true,
      total: configsForFrontend.length,
      data: configsForFrontend
    });

  } catch (err) {
    next(err);
  }
});

router.post('/:boardId', async (req, res, next) => {
  try {
    const boardId = Number(req.params.boardId)
    
    // Destructure new fields from body
    const { 
      columns, 
      groupConfig, 
      excludedEmployees,
      userId,
      userName,
      userEmail,
      apiToken
    } = req.body

    if (!columns?.employee || !columns?.client || !columns?.timeTracking1 || !columns?.timeTracking2) {
      return res.status(400).json({ message: 'Missing required columns' })
    }

    const config = await Configuration.findOneAndUpdate(
      { boardId },
      {
        $set: {
          columns,
          groupConfig: groupConfig || {},
          excludedEmployees: Array.isArray(excludedEmployees) ? excludedEmployees : [],
          // Update user info and token
          userId: userId || null,
          userName: userName || null,
          userEmail: userEmail || null,
          apiToken: apiToken ? encrypt(apiToken) :null
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
