-- Backfill session.model_original from the first user message's model info.
-- Only touches rows where model_original IS NULL.
-- Never touches session.model or session.model_override.

UPDATE session
SET model_original = (
  SELECT json_object('providerID',
    json_extract(first_msg.data, '$.model.providerID'),
    'modelID',
    json_extract(first_msg.data, '$.model.modelID'))
  FROM (
    SELECT m.data
    FROM message m
    WHERE m.session_id = session.id
      AND json_extract(m.data, '$.role') = 'user'
      AND json_extract(m.data, '$.model.providerID') IS NOT NULL
      AND json_extract(m.data, '$.model.modelID') IS NOT NULL
    ORDER BY m.time_created ASC
    LIMIT 1
  ) first_msg
)
WHERE session.model_original IS NULL;
