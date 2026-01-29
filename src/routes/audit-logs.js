import express from 'express';
const router = express.Router();
import AuditLog from '../models/AuditLogs.js';

// POST Endpoint to save or update audit log
router.post('/audit-logs', async (req, res) => {
  try {
    const { userId, userName, userEmail, boardId, queryType, executedQuery, queryResponse, timestamp } = req.body;

    // 1. Data Validate karein
    if (!executedQuery || !queryType) {
      return res.status(400).json({ error: 'Query details are required' });
    }

    // 2. Logic: Find user and Update, OR Create new if not found (Upsert)
    // Hum yahan 'userId' ko base bana rahe hain.
    
    const updatedLog = await AuditLog.findOneAndUpdate(
      { userId: userId || 'unknown' }, // Filter: Is userId ko dhundo
      {
        $set: {
          userName: userName || 'Guest',
          userEmail: userEmail || '',
          boardId: boardId,
          queryType: queryType,
          executedQuery: executedQuery,     // Yeh purana value ko overwrite karega
          queryResponse: queryResponse,     // Yeh purana value ko overwrite karega
          timestamp: timestamp || new Date() // Timestamp update ho jayegi
        }
      },
      { 
        new: true,   // Return the updated document
        upsert: true, // Agar document nahi mila toh NAYA bana do (Create)
        setDefaultsOnInsert: true 
      }
    );

    console.log(`Audit Log Saved/Updated for User: ${updatedLog.userId}`);
    res.status(201).json({ message: 'Log saved successfully', id: updatedLog._id });

  } catch (error) {
    console.error('Error saving audit log:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;