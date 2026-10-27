import type { CaseDef } from '../shared/domain'
import type { QaStore } from './store'

export const DEMO_IDS = {
  project: 'prj_demo_shop',
  environment: 'env_demo_local',
  suite: 'ste_checkout',
} as const

export const DEMO_CASES: CaseDef[] = [
  {
    id: 'storefront-loads',
    title: 'Storefront renders the cart summary',
    preconditions: 'Demo shop is running with the default cart.',
    steps: [
      {
        id: 'open-home',
        title: 'Open the storefront',
        instruction: 'Load the home page and read the cart summary.',
        request: { method: 'GET', url: '/' },
      },
    ],
    assertions: [
      { id: 'home-200', stepId: 'open-home', kind: 'status_equals', description: 'Home page answers 200', expected: 200 },
      { id: 'home-subtotal', stepId: 'open-home', kind: 'body_contains', description: 'Cart subtotal is shown', expected: 'subtotal $120.00' },
    ],
    tags: ['smoke'],
    timeoutSeconds: 60,
    cleanup: 'None. Read-only.',
  },
  {
    id: 'checkout-discount-10',
    title: 'SAVE10 takes 10% off the cart',
    preconditions: 'Cart subtotal is $120.',
    steps: [
      {
        id: 'apply-save10',
        title: 'Apply discount code SAVE10',
        instruction: 'Request the cart with discount code SAVE10 applied.',
        request: { method: 'GET', url: '/api/cart?code=SAVE10' },
      },
    ],
    assertions: [
      { id: 'save10-200', stepId: 'apply-save10', kind: 'status_equals', description: 'Cart answers 200', expected: 200 },
      { id: 'save10-discount', stepId: 'apply-save10', kind: 'json_equals', description: 'Discount is $12', path: 'discount', expected: 12 },
      { id: 'save10-total', stepId: 'apply-save10', kind: 'json_equals', description: 'Total is $108', path: 'total', expected: 108 },
    ],
    tags: ['checkout'],
    timeoutSeconds: 60,
    cleanup: 'None. Read-only.',
  },
  {
    id: 'checkout-discount-20',
    title: 'SAVE20 takes 20% off the cart',
    preconditions: 'Cart subtotal is $120.',
    steps: [
      {
        id: 'apply-save20',
        title: 'Apply discount code SAVE20',
        instruction: 'Request the cart with discount code SAVE20 applied.',
        request: { method: 'GET', url: '/api/cart?code=SAVE20' },
      },
    ],
    assertions: [
      { id: 'save20-200', stepId: 'apply-save20', kind: 'status_equals', description: 'Cart answers 200', expected: 200 },
      { id: 'save20-total', stepId: 'apply-save20', kind: 'json_equals', description: 'Total is $96', path: 'total', expected: 96 },
    ],
    tags: ['checkout'],
    timeoutSeconds: 60,
    cleanup: 'None. Read-only.',
  },
  {
    id: 'invalid-code-rejected',
    title: 'Unknown discount code is rejected',
    preconditions: 'Cart subtotal is $120.',
    steps: [
      {
        id: 'apply-bogus',
        title: 'Apply discount code BOGUS',
        instruction: 'Request the cart with discount code BOGUS.',
        request: { method: 'GET', url: '/api/cart?code=BOGUS' },
      },
    ],
    assertions: [
      { id: 'bogus-422', stepId: 'apply-bogus', kind: 'status_equals', description: 'Invalid code answers 422', expected: 422 },
      { id: 'bogus-error', stepId: 'apply-bogus', kind: 'json_equals', description: 'Error code is invalid_code', path: 'error', expected: 'invalid_code' },
    ],
    tags: ['checkout', 'negative'],
    timeoutSeconds: 60,
    cleanup: 'None. Read-only.',
  },
]

/** Seed the demo project once; on later boots only refresh the loopback
 * origin, which changes when the demo server gets a new port. Runs already
 * started keep the origin frozen in their contract. */
export function seedDemo(store: QaStore, origin: string): void {
  const exists = store.listProjects().some((p) => p.id === DEMO_IDS.project)
  if (exists) {
    store.updateEnvironmentBaseUrl(DEMO_IDS.environment, origin, [origin])
    return
  }
  store.tx(() => {
    store.createProject({ id: DEMO_IDS.project, name: 'Demo Shop', appUrl: origin, owner: 'local operator' })
    store.createEnvironment({
      id: DEMO_IDS.environment,
      projectId: DEMO_IDS.project,
      name: 'local',
      baseUrl: origin,
      allowedOrigins: [origin],
      allowMutatingMethods: false,
      secretRefs: [{ name: 'shop_test_account', ref: 'keychain://kestrel-qa/demo-shop/test-account' }],
      testDataPolicy: 'Read-only. Default cart; no writes.',
      resetInstructions: 'Restart the app; the demo shop is stateless.',
      concurrencyLimit: 1,
    })
    store.createSuite({ id: DEMO_IDS.suite, projectId: DEMO_IDS.project, name: 'Checkout' })
    store.addSuiteVersion({ suiteId: DEMO_IDS.suite, sourceRevision: 'seed-2026-10-27', cases: DEMO_CASES })
  })
}
