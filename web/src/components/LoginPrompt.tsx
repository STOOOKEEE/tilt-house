import { useNear } from '../near/useNear'

/** Shown where an action needs an account; the rest of the page stays readable. */
export function LoginPrompt({ action }: { action: string }) {
  const { auth } = useNear()
  if (!auth.available) {
    return (
      <div className="prompt">
        <span>
          Read-only demo ({auth.reason}): you can watch every table, but logging in to {action} is turned off.
        </span>
      </div>
    )
  }
  return (
    <div className="prompt">
      <span>Log in with email, Google or X to {action}. No wallet, no seed phrase.</span>
      <button type="button" disabled={!auth.ready} onClick={auth.login}>
        Login
      </button>
    </div>
  )
}
