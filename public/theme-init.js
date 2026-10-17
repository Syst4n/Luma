// Apply before styles paint; a theme preference never changes the bulbs.
try{const saved=localStorage.getItem('luma-theme');document.documentElement.dataset.theme=saved==='light'||saved==='dark'?saved:matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}catch{document.documentElement.dataset.theme='dark';}
