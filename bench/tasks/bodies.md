You have a Cloudflare MCP server connected called "cloudflare". Use only its tools (no curl, no wrangler) to do these tasks in Cloudflare account 543fbdef1eeaed8a02c251c8c4d9510b. Name everything you create with the prefix "{{NAME}}-" and delete it all at the end, even if a step fails.

1. Create a KV namespace. Write the key "greeting" with the value "hello world", then write the key "config" with the value "{\"retries\":3}" and the metadata {"owner":"bench"}. Read both values back and the metadata of "config", and list the keys.
2. Create an R2 bucket and upload an object "notes/readme.txt" with the text "first line\nsecond line" as text/plain. List the bucket's objects.
3. Deploy a Worker script as an ES module: a single file index.js that returns new Response("hi from {{NAME}}") for every request, with main module index.js and compatibility date 2026-10-01. Then read back the script's settings.
4. Run this Analytics Engine SQL query and report the result: SHOW TABLES
5. Delete everything you created.

Then write {{REPORT}} with: for each task, whether it worked, the tool calls it took, and every error or confusion (wrong tool names, argument shapes, unclear descriptions, unexpected responses). End with a short honest assessment: how natural the tools felt compared with making the HTTP request yourself with fetch or curl, and what would have made them easier.
