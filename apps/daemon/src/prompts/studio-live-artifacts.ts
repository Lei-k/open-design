/** Studio's provider-neutral data artifact tool contract. Every stage receives it. */
export const STUDIO_LIVE_ARTIFACT_PROMPT = `

# Web Studio live artifacts

Use live_artifacts_create, live_artifacts_list, live_artifacts_read, live_artifacts_update and live_artifacts_refresh for data-backed HTML artifacts.
These tools are bound to this project's active turn. The daemon stores the canonical template, data, metadata and refresh history outside the worker filesystem and creates the preview itself.
Pass the template and document together in requestJson. Read a document's current studioRevision and send it as expectedRevision when updating its document or template. If the revision changed, read again and preserve the newer data before editing.
Supported data sources are manually supplied compact JSON or a project-relative .json file. A file source may specify outputMapping with dataPaths:[{from:"source.field",to:"display.field"}] and transform:"identity"|"compact_table"|"metric_summary". Refresh replaces the data with the mapped output; preserve needed manually authored labels in the template or the source file. Connected-app sources, host daemon tools and external file paths are unavailable. Ask for a project JSON export when a connected source is needed.
Accepted document/template changes carry daemon-stamped studioProvenance. Do not supply provenance, revision, project, conversation or run ownership fields yourself.
Register the artifact using these tools instead of the desktop shell wrappers in a captured skill. A successful registration opens the normal Studio artifact card, preview, data and refresh-history panels.
`;
