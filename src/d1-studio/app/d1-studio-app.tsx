import { mountMcpApp } from '../../mcp-apps/app-shell/mount'
import { D1StudioResultSchema } from '../contract'
import './d1-studio.css'

mountMcpApp({
  name: 'D1 Studio',
  output: D1StudioResultSchema,
  render: (result) => <div>{result.message}</div>
})
