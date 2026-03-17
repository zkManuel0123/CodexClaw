param(
    [ValidateSet("exec", "resume", "review")]
    [string]$Action = "exec",

    [string]$Prompt,

    [string]$Workspace = "D:\openclaw"
)

$resolvedWorkspace = Resolve-Path -LiteralPath $Workspace -ErrorAction Stop

# Remove OpenAI env vars inherited from OpenClaw that force Codex to use the
# API endpoint instead of the ChatGPT OAuth endpoint the user is logged into.
Remove-Item Env:OPENAI_BASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:OPENAI_MODEL -ErrorAction SilentlyContinue

$arguments = @()

switch ($Action) {
    "exec" {
        $arguments += "exec"
        $arguments += "--full-auto"
        $arguments += "--skip-git-repo-check"
        $arguments += "-C"
        $arguments += $resolvedWorkspace.Path
        if ($Prompt) {
            $arguments += $Prompt
        }
    }
    "resume" {
        $arguments += "exec"
        $arguments += "resume"
        $arguments += "--last"
        $arguments += "--skip-git-repo-check"
        $arguments += "-C"
        $arguments += $resolvedWorkspace.Path
        if ($Prompt) {
            $arguments += $Prompt
        }
    }
    "review" {
        $arguments += "review"
        $arguments += "--skip-git-repo-check"
        $arguments += "-C"
        $arguments += $resolvedWorkspace.Path
        if ($Prompt) {
            $arguments += $Prompt
        }
    }
}

& codex @arguments
exit $LASTEXITCODE
