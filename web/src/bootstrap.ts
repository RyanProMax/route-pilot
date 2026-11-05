import { readInitialData } from './data';
import './status.css';

// Fetch while React and the component library download, rather than after mounting them.
void Promise.all([readInitialData(), import('./status')]).then(([initial, app]) => {
  app.mount(initial);
}).catch(() => {
  const root = document.getElementById('root');
  if (root) {
    root.className = 'startup-error';
    root.setAttribute('role', 'alert');
    root.textContent = '页面资源加载失败，请稍后重新打开。';
  }
});
