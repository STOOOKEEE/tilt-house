import { useLogin, usePrivy } from '@privy-io/react-auth'

/** Shown where an action needs an account; the rest of the page stays readable. */
export function LoginPrompt({ action }: { action: string }) {
  const { ready } = usePrivy()
  const { login } = useLogin()
  return (
    <div className="prompt">
      <span>Log in with email, Google or X to {action}. No wallet, no seed phrase.</span>
      <button type="button" disabled={!ready} onClick={() => login()}>
        Login
      </button>
    </div>
  )
}
