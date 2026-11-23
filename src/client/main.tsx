import { createRoot } from 'react-dom/client'
import { AppWithBoundary } from './App'
import './style.css'

createRoot(document.getElementById('root')!).render(<AppWithBoundary />)
