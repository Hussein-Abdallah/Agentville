// Town services: what kind of meaningful command a Bash call runs (tests, a build, git, installing
// packages, a dev server, a deploy), so the robot can show a badge for it and a pass/fail flag after.
// Quick look-arounds (ls, cat, grep…) are none of these and show nothing.
import type { ActivityKind } from '../src/types';

const RULES: [ActivityKind, RegExp][] = [
  ['deploy', /\b(deploy|vercel( --prod)?|netlify deploy|fly deploy|kubectl apply|terraform apply|docker push|gh release create|firebase deploy|eas submit)\b/],
  ['test', /\b((npm|pnpm|yarn|bun)( run)? test|vitest|jest|pytest|py\.test|go test|cargo test|mocha|playwright test|cypress run|tsx --test|node --test|rspec|phpunit|dotnet test|mvn test|gradle test|swift test|xcodebuild test)\b/],
  ['build', /\b((npm|pnpm|yarn|bun)( run)? (build|typecheck|lint|check)|tsc|vite build|next build|webpack|esbuild|rollup|eslint|prettier --check|ruff|mypy|cargo (build|check|clippy)|go (build|vet)|make|cmake|gradle build|mvn (package|compile)|xcodebuild|swift build|dotnet build)\b/],
  ['install', /\b((npm|pnpm|yarn|bun) (i|install|ci|add)|pip3? install|uv (sync|add|pip install)|poetry (install|add)|brew install|bundle install|cargo add|go (get|mod download)|composer install|pod install)\b/],
  ['git', /(^|[;&|]\s*)(git (commit|push|pull|fetch|merge|rebase|checkout|switch|clone|tag|cherry-pick|stash)|gh pr (create|merge|checkout))\b/],
  ['server', /\b((npm|pnpm|yarn|bun)( run)? (dev|start|serve|preview)|vite( dev)?$|next (dev|start)|uvicorn|flask run|rails s(erver)?|php artisan serve|python3? -m http\.server|docker compose up|docker-compose up|nodemon|tsx watch)\b/],
];

/** The kind of a shell command, or undefined for everyday commands. The first matching rule wins (a deploy that runs tests is a deploy). */
export function activityOf(command: unknown): ActivityKind | undefined {
  if (typeof command !== 'string') return;
  // ignore what's quoted or fed in (commit messages, heredocs): "fix tests" isn't running tests
  const c = command.replace(/<<-?\s*['"]?\w+['"]?[\s\S]*$/, '').replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''").replace(/\s+/g, ' ').trim();
  for (const [kind, re] of RULES) if (re.test(c)) return kind;
}

/** How a finished command reads in the details history. */
export const RESULT_TEXT: Record<ActivityKind, [string, string]> = {
  test: ['Tests passed', 'Tests failed'],
  build: ['Build passed', 'Build failed'],
  git: ['Git done', 'Git failed'],
  install: ['Packages installed', 'Install failed'],
  server: ['Server stopped', 'Server failed'],
  deploy: ['Deployed', 'Deploy failed'],
};
