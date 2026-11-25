import { number, SafeError } from './core.js';

export function isCommand(event, env, command) {
  return env.GITHUB_EVENT_NAME === 'issue_comment'
    && event.action === 'created'
    && !event.issue?.pull_request
    && event.comment?.user?.type === 'User'
    && event.comment.user.login === env.GITHUB_ACTOR
    && typeof event.comment.body === 'string'
    && event.comment.body.trim() === command;
}
// Re-read from GitHub at preparation and publication. Deleted/edited commands cannot authorize work.
export async function requireCommand(gh, event, env, command) {
  if (!isCommand(event,env,command) || event.repository?.full_name !== gh.repo) throw new SafeError('ACCESS');
  const n=number(event.issue?.number),id=number(event.comment.id);
  const current=await gh.request(gh.path(`/issues/comments/${id}`));
  if (current.user?.type !== 'User' || current.user.login !== env.GITHUB_ACTOR
    || current.issue_url !== `https://api.github.com/repos/${gh.repo}/issues/${n}`
    || typeof current.body !== 'string' || current.body.trim() !== command) throw new SafeError('ACCESS');
  return n;
}
