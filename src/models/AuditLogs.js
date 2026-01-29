import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  userName: { type: String, required: true },
  userEmail: { type: String },
  boardId: { type: Number },
  queryType: { type: String }, // e.g., 'initial', 'pagination'
  executedQuery: { type: String }, // GraphQL Query String
  queryResponse: { type: mongoose.Schema.Types.Mixed }, // Flexible JSON data
  timestamp: { type: Date, default: Date.now }
});
const AuditLog = mongoose.model('AuditLog', auditLogSchema);

export default AuditLog;
