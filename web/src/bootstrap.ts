import { cachedInitialData, readInitialData } from './data';
import './status.css';
import './app.css';

// Start public data and the app together; a slow status response must not block the header.
const cached = cachedInitialData();
const pending = cached ? undefined : readInitialData();
void import('./app').then(app => {
  app.mount(cached ?? { instances: [], bundle: null, instanceError: false, error: false, completedAt: 0 }, pending);
}).catch(() => {
  const root = document.getElementById('root');
  if (root) {
    root.className = 'startup-error';
    root.setAttribute('role', 'alert');
    root.textContent = '页面资源加载失败，请稍后重新打开。';
  }
});
