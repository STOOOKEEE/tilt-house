import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { loadNetworkChoice, readConfig, type Config } from './config'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing root element')

let config: Config | null = null
let configError = ''
try {
  config = readConfig(import.meta.env, loadNetworkChoice(localStorage))
} catch (error) {
  configError = error instanceof Error ? error.message : String(error)
}

createRoot(root).render(
  <StrictMode>{config ? <App config={config} /> : <pre className="fatal">{configError}</pre>}</StrictMode>,
)
