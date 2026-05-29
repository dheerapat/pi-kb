/**
 * prompts.ts — Prompt templates for the KB extension.
 *
 * These are injected into the pi session via sendUserMessage when a command
 * runs. The LLM uses the kb_* tools to carry out the instructions.
 *
 * All prompt builders accept an optional `workspace` parameter. When set,
 * the prompt instructs the LLM to pass that workspace name to every tool call.
 */

// ---------------------------------------------------------------------------
// Compile prompt (for /kb-add)
// ---------------------------------------------------------------------------

export function buildCompilePrompt(
  sourceName: string,
  docName: string,
  content: string,
  workspace?: string,
): string {
  const wsContext = workspace
    ? [
        `**Workspace:** \`${workspace}\``,
        ``,
        `IMPORTANT: Pass \`workspace="${workspace}"\` to EVERY kb_* tool call.`,
      ].join("\n")
    : `**Workspace:** default (no workspace param needed)`;

  return [
    `[kb-compile] Add the following document to the knowledge base.`,
    ``,
    wsContext,
    ``,
    `**Source file:** ${sourceName}`,
    `**Doc name (slug for summaries/concepts):** ${docName}`,
    ``,
    `## Document content`,
    ``,
    content,
    ``,
    `---`,
    ``,
    `## Knowledge Base Compilation Instructions`,
    ``,
    `You are compiling a personal knowledge base. The wiki has this structure:`,
    ``,
    `- \`wiki/index.md\` — One-liner index of ALL pages (Documents and Concepts sections)`,
    `- \`wiki/summaries/{docName}.md\` — One summary per source document`,
    `- \`wiki/concepts/{slug}.md\` — Cross-document topic synthesis pages`,
    ``,
    `**Important:** Before writing ANYTHING, always read the current state. Never`,
    `assume the wiki is empty.`,
    ``,
    `### Step 1: Read current state`,
    `Call \`kb_read_index\` to see the current index.`,
    `Call \`kb_list_concepts\` to see existing concept slugs.`,
    ``,
    `### Step 2: Write the summary`,
    `Write a concise summary (200-400 words) for this document. Call:`,
    `\`kb_write_summary(docName="${docName}", content=<summary>)\``,
    `The summary should capture key ideas, findings, and contributions.`,
    ``,
    `### Step 3: Extract and integrate concepts`,
    `For each cross-cutting topic this document touches:`,
    ``,
    `* **If the topic matches an EXISTING concept:**`,
    `  1. Call \`kb_read_concept(slug)\` to read its current content`,
    `  2. Call \`kb_update_concept(slug, content, source="summary/${docName}")\``,
    `     to rewrite the body with new info integrated. The new source is`,
    `     automatically merged — old sources are preserved.`,
    ``,
    `* **If the topic is NEW and substantive:**`,
    `  Call \`kb_write_concept(slug, content, sources=["summary/${docName}"])\` to create from scratch.`,
    ``,
    `**IMPORTANT:** The \`sources\` parameter expects summary page references like`,
    `\`["summary/${docName}"]\`, NOT raw filenames like \`["${docName}.md"]\`.`,
    ``,
    `Concept slug rules: lowercase, hyphens, 4 words max.`,
    `  Good: "caching-strategy", "api-authentication"`,
    `  Bad: "Cache", "Stuff about APIs and things"`,
    ``,
    `Do not create one-concept-per-document — merge overlapping themes.`,
    ``,
    `### Step 4: Update the index`,
    `Call \`kb_update_index(entries)\` with a COMPLETE list of ALL pages`,
    `(summaries + concepts). Include every existing page, not just new ones.`,
    `Each entry: \`{ type: "summary"|"concept", slug: "...", brief: "one-liner" }\``,
    ``,
    `### Formatting rules`,
    `- Concepts MUST be cross-document synthesis, not single-document regurgitation`,
    `- Be concise. Wiki content should be scannable.`,
    `- Do NOT write footer sections — they are generated automatically.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Compile prompt for /kb-add-content (inline text, no file/URL)
// ---------------------------------------------------------------------------

export function buildCompilePromptInline(
  tempDocName: string,
  content: string,
  workspace?: string,
): string {
  const wsContext = workspace
    ? [
        `**Workspace:** \`${workspace}\``,
        ``,
        `IMPORTANT: Pass \`workspace="${workspace}"\` to EVERY kb_* tool call.`,
      ].join("\n")
    : `**Workspace:** default (no workspace param needed)`;

  return [
    `[kb-compile] Add the following inline content to the knowledge base.`,
    ``,
    wsContext,
    ``,
    `**Temporary docName:** ${tempDocName}`,
    ``,
    `## Document content`,
    ``,
    content,
    ``,
    `---`,
    ``,
    `## Knowledge Base Compilation Instructions`,
    ``,
    `### Step 0: Choose a meaningful docName`,
    `This content came from an inline paste (no file or URL). It has`,
    `an auto-generated temporary docName: \`${tempDocName}\`.`,
    ``,
    `Read the content, pick a meaningful docName slug, and call:`,
    `\`kb_set_docname(oldDocName="${tempDocName}", newDocName="<your-slug>")\``,
    ``,
    `This renames the source file and updates the registry.`,
    `You MUST call \`kb_set_docname\` before any other tool call.`,
    `Use the new docName in all subsequent calls.`,
    ``,
    `### Important: before writing ANYTHING, always read current state`,
    `Call \`kb_read_index\` to see the current index.`,
    `Call \`kb_list_concepts\` to see existing concept slugs.`,
    ``,
    `### Step 1: Write the summary`,
    `Write a concise summary (200-400 words) for this document. Call:`,
    `\`kb_write_summary(docName=<newDocName>, content=<summary>)\``,
    `The summary should capture key ideas, findings, and contributions.`,
    ``,
    `### Step 2: Extract and integrate concepts`,
    `For each cross-cutting topic this document touches:`,
    ``,
    `* **If the topic matches an EXISTING concept:**`,
    `  1. Call \`kb_read_concept(slug)\` to read its current content`,
    `  2. Call \`kb_update_concept(slug, content, source="summary/<newDocName>")\``,
    `     to rewrite the body with new info integrated. The new source is`,
    `     automatically merged — old sources are preserved.`,
    ``,
    `* **If the topic is NEW and substantive:**`,
    `  Call \`kb_write_concept(slug, content, sources=["summary/<newDocName>"])\` to create from scratch.`,
    ``,
    `**IMPORTANT:** The \`sources\` parameter expects summary page references like`,
    `\`["summary/<newDocName>"]\`, NOT raw filenames like \`["<newDocName>.md"]\`.`,
    ``,
    `Concept slug rules: lowercase, hyphens, 4 words max.`,
    `  Good: "caching-strategy", "api-authentication"`,
    `  Bad: "Cache", "Stuff about APIs and things"`,
    ``,
    `Do not create one-concept-per-document — merge overlapping themes.`,
    ``,
    `### Step 3: Update the index`,
    `Call \`kb_update_index(entries)\` with a COMPLETE list of ALL pages`,
    `(summaries + concepts). Include every existing page, not just new ones.`,
    `Each entry: \`{ type: "summary"|"concept", slug: "...", brief: "one-liner" }\``,
    ``,
    `### Formatting rules`,
    `- Concepts MUST be cross-document synthesis, not single-document regurgitation`,
    `- Be concise. Wiki content should be scannable.`,
    `- Do NOT write footer sections — they are generated automatically.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Query prompt (for /kb-query)
// ---------------------------------------------------------------------------

export function buildQueryPrompt(question: string, workspace?: string): string {
  const wsContext = workspace
    ? [
        `**Workspace:** \`${workspace}\``,
        ``,
        `IMPORTANT: Pass \`workspace="${workspace}"\` to EVERY kb_* tool call.`,
      ].join("\n")
    : `**Workspace:** default (no workspace param needed)`;

  return [
    `[kb-query] Answer the following question using ONLY the knowledge base.`,
    ``,
    wsContext,
    ``,
    `## Search strategy`,
    `1. Call \`kb_read_index\` to see all documents and concepts with brief descriptions.`,
    `2. Based on the index, identify which summaries are relevant.`,
    `3. Call \`kb_read_summary(docName)\` on the relevant ones.`,
    `4. If deeper detail is needed, call \`kb_read_concept(slug)\` on relevant concepts.`,
    `5. Synthesize a clear, concise answer grounded in kb content.`,
    ``,
    `If the KB does not contain relevant information, say so clearly.`,
    ``,
    `**Question:** ${question}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Remove Phase 2 prompt (surgical excision, not from-scratch rewrite)
//
// Phase 1 (deterministic) has already:
//   - Deleted the summary
//   - Removed the source from each concept's sources list
//   - Set `needs_review: true` in affected concept frontmatter
//   - Deleted concepts that had no sources left
//   - Rebuilt the index
//   - Deleted the source file
//   - Deleted the registry entry
//
// Phase 2 (this prompt) asks the LLM to surgically remove content traceable
// to the deleted document from remaining concept bodies.
// ---------------------------------------------------------------------------

export function buildRemovePrompt(
  docName: string,
  sourceName: string,
  affectedConceptSlugs: string[],
  workspace?: string,
): string {
  const wsContext = workspace
    ? [
        `**Workspace:** \`${workspace}\``,
        ``,
        `IMPORTANT: Pass \`workspace="${workspace}"\` to EVERY kb_* tool call.`,
      ].join("\n")
    : `**Workspace:** default (no workspace param needed)`;

  const slugList = affectedConceptSlugs
    .map((s) => `- \`concepts/${s}.md\``)
    .join("\n");

  return [
    `[kb-remove-phase-2] The document "${sourceName}" (docName: ${docName}) was removed from the knowledge base.`,
    `Phase 1 has already: deleted the summary, updated concept source lists, rebuilt the index, and removed the registry entry.`,
    ``,
    `The following concept pages previously referenced "${sourceName}" and have \`needs_review: true\` in their frontmatter:`,
    ``,
    slugList,
    ``,
    wsContext,
    ``,
    `### Instructions`,
    `For EACH concept listed above:`,
    ``,
    `1. Call \`kb_read_concept(slug)\` to read the current body.`,
    `   It will show \`⚠ needs_review: true\` in the output.`,
    ``,
    `2. Identify content that came from the removed document "${sourceName}".`,
    `   Remove ONLY that content. Keep everything traceable to the remaining sources.`,
    ``,
    `3. Call \`kb_write_concept(slug, cleanedBody, sources)\`.`,
    `   **IMPORTANT:** The sources list in the frontmatter is ALREADY CORRECT.`,
    `   Read it from the concept (\`kb_read_concept\` shows sources), verify it does NOT`,
    `   contain \`summary/${docName}\`, and pass it through UNCHANGED.`,
    `   The \`needs_review\` flag will be reset to false on write.`,
    ``,
    `If you cannot confidently identify which content came from "${sourceName}",`,
    `still call \`kb_write_concept\` with the body unchanged — the write will`,
    `clear \`needs_review\` and the concept will be marked as clean.`,
    ``,
    `DO NOT call \`kb_update_index\` — the index was already rebuilt in Phase 1.`,
    `DO NOT call \`kb_delete_summary\` or \`kb_delete_concept\` — those were handled in Phase 1.`,
  ].join("\n");
}
