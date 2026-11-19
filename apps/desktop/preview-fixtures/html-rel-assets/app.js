// ES module + fetch('./data.json'). Both used to fail under file:// in
// WebKitGTK, which is why the preview is served from a loopback origin.
const status = document.querySelector('#status')
const result = document.querySelector('#result')

try {
  const response = await fetch('./data.json')
  const data = await response.json()

  status.textContent = 'ok'
  result.textContent = JSON.stringify(data, null, 2)
  document.body.dataset.fixtureResult = 'ok'
} catch (error) {
  status.textContent = `failed: ${error}`
  document.body.dataset.fixtureResult = 'failed'
}
