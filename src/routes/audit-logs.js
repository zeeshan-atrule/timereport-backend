const express = require('express');
const router = express.Router();
const AuditLog = require('../models/AuditLog'); // MongoDB Model baad mein banayenge

// POST Endpoint to save audit log
router.post('/audit-logs', async (req, res) => {
  try {
    const { userId, userName, userEmail, boardId, queryType, executedQuery, queryResponse, timestamp } = req.body;

    // 1. Data Validate karein
    if (!executedQuery || !queryType) {
      return res.status(400).json({ error: 'Query details are required' });
    }

    // 2. Naya Log Entry create karein
    const newLog = new AuditLog({
      userId: userId || 'unknown', // Agar frontend se nahi aaya to default
      userName: userName || 'Guest',
      userEmail: userEmail || '',
      boardId: boardId,
      queryType: queryType,
      executedQuery: executedQuery,
      queryResponse: queryResponse, // MongoDB isse JSON format mein save kar dega
      timestamp: timestamp || new Date()
    });

    // 3. Database mein Save karein
    const savedLog = await newLog.save();

    console.log(`Audit Log Saved: ${savedLog._id}`);
    res.status(201).json({ message: 'Log saved successfully', id: savedLog._id });

  } catch (error) {
    console.error('Error saving audit log:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;