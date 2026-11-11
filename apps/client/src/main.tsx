import { createRoot } from 'react-dom/client';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(<p>Chickens of Yolk Street</p>);
