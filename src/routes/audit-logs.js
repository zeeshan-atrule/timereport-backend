import express from 'express';
const router = express.Router();
import AuditLog from '../models/AuditLogs.js';

// POST Endpoint to save audit log
router.post('/audit-logs', async (req, res) => {
  try {
    const { userId, userName, userEmail, boardId, queryType, executedQuery, queryResponse, timestamp } = req.body;

    // 1. Data Validate karein
    if (!executedQuery || !queryType) {
      return res.status(400).json({ error: 'Query details are required' });
    }

    // 2. Naya Log Entry create karein (History rakhne ke liye save() use kiya)
    // Note: Agar aap chahate hain ke purana update ho, toh .save() ki jagah .findOneAndUpdate() use karein.
    // Lekin "Har query ka alag" ke liye .save() zaroori hai.
    const newLog = new AuditLog({
      userId: userId || 'unknown',
      userName: userName || 'Guest',
      userEmail: userEmail || '',
      boardId: boardId,
      queryType: queryType,
      executedQuery: executedQuery,
      queryResponse: queryResponse, // MongoDB isse JSON format mein save kar dega (Success ya Error dono)
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

router.get('/audit-logs', async (req, res) => {
  try {
    const {
      userId,
      boardId,
      queryType,
      limit = 20,
      page = 1
    } = req.query;

    // 1. Filters dynamically build karein
    const filter = {};
    if (userId) filter.userId = userId;
    if (boardId) filter.boardId = boardId;
    if (queryType) filter.queryType = queryType;

    // 2. Pagination logic
    const skip = (Number(page) - 1) * Number(limit);

    // 3. Logs fetch karein (latest first)
    const logs = await AuditLog.find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(Number(limit));

    // 4. Total count (pagination ke liye)
    const total = await AuditLog.countDocuments(filter);

    res.status(200).json({
      success: true,
      total,
      page: Number(page),
      limit: Number(limit),
      data: logs
    });

  } catch (error) {
    console.error('Error fetching audit logs:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


export default router;