/**
 * prompts.ts — Prompt templates for the KB extension.
 *
 * These are injected into the pi session via sendUserMessage when a command
 * runs. The LLM uses the kb_* tools to carry out the instructions.
 */

// ---------------------------------------------------------------------------
// Compile prompt (for /kb-add)
// ---------------------------------------------------------------------------

export function buildCompilePrompt(
  sourceName: string,
  docName: string,
  content: string,
): string {
  return [
    `[kb-compile] Add the following document to the knowledge base.`,
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
    `  2. Call \`kb_write_concept(slug, content, sources)\` to REWRITE the full`,
    `     page, integrating the new information naturally into the existing body.`,
    `     Add this document's source name to the sources list.`,
    ``,
    `* **If the topic is NEW and substantive:**`,
    `  Call \`kb_write_concept(slug, content, sources)\` to create from scratch.`,
    ``,
    `Concept slug rules: lowercase, hyphens, 4 words max.`,
    `  Good: "caching-strategy", "api-authentication"`,
    `  Bad: "Cache", "Stuff about APIs and things"`,
    ``,
    `For the first 3 documents in the KB, create at most 2-4 concepts total.`,
    `Do not create one-concept-per-document — merge overlapping themes.`,
    ``,
    `### Step 4: Update the index`,
    `Call \`kb_update_index(entries)\` with a COMPLETE list of ALL pages`,
    `(summaries + concepts). Include every existing page, not just new ones.`,
    `Each entry: \`{ type: "summary"|"concept", slug: "...", brief: "one-liner" }\``,
    ``,
    `### Formatting rules`,
    `- Use \`[[summary/${docName}]]\` to link to summaries`,
    `- Use \`[[concept/slug]]\` to link to concepts`,
    `- Concepts MUST be cross-document synthesis, not single-document regurgitation`,
    `- Be concise. Wiki content should be scannable.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Query prompt (for /kb-query)
// ---------------------------------------------------------------------------

export function buildQueryPrompt(question: string): string {
  return [
    `[kb-query] Answer the following question using ONLY the knowledge base.`,
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
// Remove prompt (for /kb-remove)
// ---------------------------------------------------------------------------

export function buildRemovePrompt(docName: string, sourceName: string): string {
  return [
    `[kb-remove] Remove the document "${sourceName}" (docName: ${docName}) from the knowledge base.`,
    ``,
    `### Instructions`,
    `1. Call \`kb_read_index\` to see the current state.`,
    `2. For each concept page that lists "${sourceName}" in its sources, call \`kb_read_concept(slug)\`.`,
    `3. If the concept has OTHER sources besides "${sourceName}":`,
    `   - Rewrite the concept to remove information from this document`,
    `   - Remove "${sourceName}" from the sources list`,
    `   - Call \`kb_write_concept(slug, content, sources)\` with the updated version`,
    `4. If "${sourceName}" was the ONLY source for a concept:`,
    `   - Call \`kb_delete_concept(slug)\` to remove it`,
    `5. Call \`kb_delete_summary("${docName}")\` to remove the summary page.`,
    `6. Call \`kb_update_index(entries)\` with the COMPLETE remaining list of ALL pages.`,
  ].join("\n");
}
