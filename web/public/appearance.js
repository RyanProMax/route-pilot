// Apply the saved palette before the first paint, including the offline page.
try {
  if (localStorage.getItem('routepilot-theme') === 'light') {
    document.documentElement.dataset.theme = 'light';
    document.querySelector('meta[name="theme-color"]').content = '#ffffff';
  }
} catch { /* The default theme also works with storage disabled. */ }
