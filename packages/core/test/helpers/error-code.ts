import { isPeersError } from '@agent-peers/protocol'

/** The PeersError code a promise rejects with ('resolved' when it doesn't reject, 'non-peers' for other errors). */
export async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'resolved'
  } catch (error) {
    return isPeersError(error) ? error.code : 'non-peers'
  }
}
