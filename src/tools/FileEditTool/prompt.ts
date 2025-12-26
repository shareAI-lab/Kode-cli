import { NotebookEditTool } from '@tools/NotebookEditTool/NotebookEditTool'

export const DESCRIPTION = `Performs exact string replacements in files.

Usage:
- You must use your \`Read\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.

For moving or renaming files, use the Bash tool with 'mv' command. For larger edits, use the Write tool. For Jupyter notebooks (.ipynb files), use ${NotebookEditTool.name}.

Parameters:
1. file_path: Absolute path to the file (must start with /)
2. old_string: Text to replace (must be unique in file, match exactly including whitespace)
3. new_string: Replacement text
4. replace_all: (optional) If true, replace all occurrences of old_string
5. old_str_start_line_number: (optional) Start line number hint for disambiguating multiple matches
6. old_str_end_line_number: (optional) End line number hint for disambiguating multiple matches

SMART MATCHING FEATURES:
- Fuzzy matching: If exact match fails, attempts intelligent fuzzy matching when line numbers are provided
- Line number tolerance: Tolerates minor line number drift from file modifications
- Tab indent auto-fix: Automatically handles tab vs space indentation mismatches

REQUIREMENTS:
1. UNIQUENESS: old_string MUST uniquely identify the change location
   - Include 3-5 lines of context before AND after the change point
   - Preserve all whitespace and indentation exactly

2. SINGLE INSTANCE: Changes one instance at a time (unless replace_all=true)
   - For multiple changes, make separate tool calls

3. VERIFICATION: Before editing
   - Read the file first using Read tool
   - Check how many instances of target text exist
   - If multiple matches exist, provide line number hints or more context

WARNINGS:
- Tool fails if old_string matches multiple locations (without line hints)
- Tool fails if old_string doesn't match exactly (fuzzy matching may help)
- Always ensure edit results in valid, idiomatic code

NEW FILE CREATION:
- Use new file path, empty old_string, and file contents as new_string
`
