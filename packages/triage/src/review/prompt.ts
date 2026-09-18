/** What the reviewer's colleague knows going in: the pull request as GitHub describes it. */
export interface ReviewIntent {
  title: string;
  /** Pull request description, already trimmed to a sensible length. */
  body: string;
  author: string;
  headRef: string;
  baseRef: string;
}
