// =====================================================================
// Aggregate data
// =====================================================================
// n8n Code node — sits between IF (true branch) and Gemini-Agent.
// FOW outputs one item per scheduled run; this collapses them into a
// single item with a `recommendations` array so the LLM sees the whole
// week in one prompt instead of being called once per day.
// =====================================================================

return [{
  json: {
    mode: $input.first().json.mode,
    recommendations: $input.all().map(i => i.json)
  }
}];
