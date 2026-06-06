// A tiny zero-dependency storefront: a JSON API (`GET /account`) and the HTML
// pages a browser flow walks (`/login` -> `/dashboard`). Run it with plain Node:
//
//     node server.js          # or: npm start
//
// No install, no framework — the only moving part is `account.js`, which carries
// the intentional contract bug this tutorial is about.
import { createServer } from 'node:http'
import { getAccount } from './account.js'

const PORT = Number(process.env.PORT ?? 8137)

const page = (title, body) => `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>${title}</title></head>
  <body><main>${body}</main></body>
</html>`

const loginPage = page(
  'Sign in — Storefront',
  `<h1>Sign in</h1>
   <form action="/dashboard" method="get">
     <label>Username <input aria-label="Username" name="username" type="text" /></label>
     <!-- A real app would use type="password"; we use text so the role-based
          browser flow can target it. Sackville redacts the secret value either way. -->
     <label>Password <input aria-label="Password" name="password" type="text" /></label>
     <button type="submit">Sign in</button>
   </form>`,
)

const dashboardPage = page(
  'Dashboard — Storefront',
  `<h1>Dashboard</h1>
   <p>Account balance: <span id="balance">…</span></p>
   <script>
     fetch('/account')
       .then((r) => r.json())
       .then((a) => {
         // The UI coerces balance to a number, so a string '10000' renders fine —
         // which is exactly why the contract bug is invisible here.
         document.getElementById('balance').textContent = new Intl.NumberFormat('en-US', {
           style: 'currency',
           currency: a.currency,
         }).format(a.balance / 100)
       })
   </script>`,
)

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  if (url.pathname === '/account') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(getAccount()))
    return
  }
  if (url.pathname === '/dashboard') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(dashboardPage)
    return
  }
  if (url.pathname === '/login' || url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(loginPage)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

server.listen(PORT, () => {
  console.log(`storefront listening on http://localhost:${PORT}`)
})
