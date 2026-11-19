import { test, expect } from '@playwright/test'

// Windows smoke: OmniRoute selection must NOT attempt to install or detect a
// Copilot CLI. Backend is a stub returning canned setup state.

test('setup driver: omniroute never shells to copilot', async ({ page }) => {
  await page.route('**/api/setup/status', route =>
    route.fulfill({
      json: { configured: false, provider: null, model: null, terminal_backend: 'local' },
    }),
  )

  let providerCalls: string[] = []
  await page.route('**/api/setup/provider', route => {
    providerCalls.push(route.request().postDataJSON()?.provider ?? '<unset>')
    return route.fulfill({ json: { status: 'ready' } })
  })

  await page.goto('/')
  await expect(page.getByText('Welcome to Alice')).toBeVisible()
  await page.getByRole('button', { name: /OmniRoute/i }).click()
  await expect(page.getByText('Where should commands run?')).toBeVisible()

  // OmniRoute path must skip /api/setup/provider entirely (nothing to
  // provision on the backend until the model actually runs).
  expect(providerCalls).toEqual([])
})
