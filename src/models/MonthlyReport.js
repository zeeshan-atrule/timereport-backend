import mongoose from 'mongoose'



const ClientSchema = new mongoose.Schema(
  {
    clientName: String,
    clientId: String,
    month: String,
    minutes: Number,
    // optional, added by aggregation for reporting convenience
    hours: Number
  },
  { _id: false }
)

const EmployeeSchema = new mongoose.Schema(
  {
    employeeName: String,
    employeeId: String,
    otherClients: [ClientSchema],
    totalWorkedHours: Number,
    totalClientHours: Number
  },
  // strict: false allows dynamic keys like "the dash": 1, "simpleday": 1, etc.
  { _id: false, strict: false }
)

const MonthlyReportSchema = new mongoose.Schema(
  {
    boardId: { type: Number, required: true, index: true },
    monthKey: { type: String, required: true, index: true },
    // Human readable month label, e.g. "December 2025"
    monthName: { type: String },
    tasks: { type: [EmployeeSchema], default: [] },
    generatedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
)

MonthlyReportSchema.index({ boardId: 1, monthKey: 1 }, { unique: true })

export default mongoose.model('MonthlyReport', MonthlyReportSchema)


