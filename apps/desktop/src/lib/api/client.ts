// Shared profile scope for every profile-scoped REST call.
//
// `setApiRequestProfile` is pushed in from `store/profile.ts` so the API layer
// never imports a store (that would be a cycle). Null → the primary backend, so
// single-profile users are unaffected.

let _apiProfile: null | string = null

export function setApiRequestProfile(profile: null | string): void {
  _apiProfile = profile || null
}

export function profileScoped(): { profile?: string } {
  return _apiProfile ? { profile: _apiProfile } : {}
}
