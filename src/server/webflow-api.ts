// Webflow Data API v2 — only what the webhook needs: delete a junk form submission.
import { errMsg, log } from './log.js';

export async function deleteWebflowSubmission(token: string, submissionId: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!/^[a-f0-9]{24}$/i.test(submissionId)) return false;
  try {
    const r = await fetchImpl(`https://api.webflow.com/v2/form_submissions/${submissionId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(5_000),
    });
    if (r.status === 204 || r.status === 200 || r.status === 404) return true; // 404: already gone
    log.warn('webflow.delete.rejected', { status: r.status });
    return false;
  } catch (e) {
    log.warn('webflow.delete.error', { err: errMsg(e) });
    return false;
  }
}
