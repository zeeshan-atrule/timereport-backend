import mongoose from 'mongoose'

const ColumnSchema = new mongoose.Schema(
  {
    employee: { type: String, required: true },
    client: { type: String, required: true },
    timeTracking1: { type: String, required: true },
    timeTracking2: { type: String, required: true }
  },
  { _id: false }
)

const ConfigurationSchema = new mongoose.Schema(
  {
    boardId: { type: Number, required: true, index: true, unique: true },
    columns: { type: ColumnSchema, required: true },
    groupConfig: { type: Map, of: [String], default: {} }
  },
  {
    timestamps: true
  }
)

export default mongoose.model('Configuration', ConfigurationSchema)


