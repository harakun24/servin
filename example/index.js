
import { serve, param, wire } from "../index.js";

const tasksDb = new Map([
  [1, { id: 1, title: "Design domain tree", priority: "high", done: true }],
  [
    2,
    {
      id: 2,
      title: "Write integration tests",
      priority: "medium",
      done: false,
    },
  ],
]);

await serve({
  port: 3000,
  api: {
    // GET /health
    health: {
      get: () => ({ status: "ok" }),
    },

    // GET /tasks?done=false
    tasks: {
      get(query) {
        let list = [...tasksDb.values()];
        if (query.done === "true") list = list.filter((t) => t.done);
        if (query.done === "false") list = list.filter((t) => !t.done);
        return list;
      },
      $id: param('int', {
        // GET /tasks/:id
        get(id) {
          const task = tasksDb.get(id);
          if (!task) wire.abort(404, `Task #${id} not found`);
          return task;
        }
      })
    },
  },
});
