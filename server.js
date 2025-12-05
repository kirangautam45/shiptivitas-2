import express from 'express';
import Database from 'better-sqlite3';

const app = express();

app.use(express.json());

// Enable CORS for frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.get('/', (req, res) => {
  return res.status(200).send({'message': 'SHIPTIVITY API. Read documentation to see API docs'});
});

// We are keeping one connection alive for the rest of the life application for simplicity
const db = new Database('./clients.db');

// Don't forget to close connection when server gets terminated
const closeDb = () => db.close();
process.on('SIGTERM', closeDb);
process.on('SIGINT', closeDb);

/**
 * Validate id input
 * @param {any} id
 */
const validateId = (id) => {
  if (Number.isNaN(id)) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid id provided.',
      'long_message': 'Id can only be integer.',
      },
    };
  }
  const client = db.prepare('select * from clients where id = ? limit 1').get(id);
  if (!client) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid id provided.',
      'long_message': 'Cannot find client with that id.',
      },
    };
  }
  return {
    valid: true,
  };
}

/**
 * Validate priority input
 * @param {any} priority
 */
const validatePriority = (priority) => {
  if (Number.isNaN(priority)) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid priority provided.',
      'long_message': 'Priority can only be positive integer.',
      },
    };
  }
  return {
    valid: true,
  }
}

/**
 * Get all of the clients. Optional filter 'status'
 * GET /api/v1/clients?status={status} - list all clients, optional parameter status: 'backlog' | 'in-progress' | 'complete'
 */
app.get('/api/v1/clients', (req, res) => {
  const status = req.query.status;
  if (status) {
    // status can only be either 'backlog' | 'in-progress' | 'complete'
    if (status !== 'backlog' && status !== 'in-progress' && status !== 'complete') {
      return res.status(400).send({
        'message': 'Invalid status provided.',
        'long_message': 'Status can only be one of the following: [backlog | in-progress | complete].',
      });
    }
    const clients = db.prepare('select * from clients where status = ? order by priority asc').all(status);
    return res.status(200).send(clients);
  }
  const clients = db.prepare('select * from clients order by status, priority asc').all();
  return res.status(200).send(clients);
});

/**
 * Get a client based on the id provided.
 * GET /api/v1/clients/{client_id} - get client by id
 */
app.get('/api/v1/clients/:id', (req, res) => {
  const id = parseInt(req.params.id , 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    res.status(400).send(messageObj);
  }
  return res.status(200).send(db.prepare('select * from clients where id = ?').get(id));
});

/**
 * Validate status input
 * @param {any} status
 */
const validateStatus = (status) => {
  if (status !== 'backlog' && status !== 'in-progress' && status !== 'complete') {
    return {
      valid: false,
      messageObj: {
        'message': 'Invalid status provided.',
        'long_message': 'Status can only be one of the following: [backlog | in-progress | complete].',
      },
    };
  }
  return {
    valid: true,
  };
};

/**
 * Update client information based on the parameters provided.
 * When status is provided, the client status will be changed
 * When priority is provided, the client priority will be changed with the rest of the clients accordingly
 * Note that priority = 1 means it has the highest priority (should be on top of the swimlane).
 * No client on the same status should not have the same priority.
 * This API should return list of clients on success
 *
 * PUT /api/v1/clients/{client_id} - change the status of a client
 *    Data:
 *      status (optional): 'backlog' | 'in-progress' | 'complete',
 *      priority (optional): integer,
 *
 */
app.put('/api/v1/clients/:id', (req, res) => {
  const id = parseInt(req.params.id , 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    return res.status(400).send(messageObj);
  }

  let { status, priority } = req.body;
  const client = db.prepare('select * from clients where id = ?').get(id);

  // Validate status if provided
  if (status !== undefined) {
    const { valid: statusValid, messageObj: statusMessageObj } = validateStatus(status);
    if (!statusValid) {
      return res.status(400).send(statusMessageObj);
    }
  }

  // Validate priority if provided
  if (priority !== undefined) {
    priority = parseInt(priority, 10);
    const { valid: priorityValid, messageObj: priorityMessageObj } = validatePriority(priority);
    if (!priorityValid) {
      return res.status(400).send(priorityMessageObj);
    }
    if (priority < 1) {
      return res.status(400).send({
        'message': 'Invalid priority provided.',
        'long_message': 'Priority must be a positive integer starting from 1.',
      });
    }
  }

  const oldStatus = client.status;
  const oldPriority = client.priority;
  const newStatus = status !== undefined ? status : oldStatus;
  const newPriority = priority !== undefined ? priority : oldPriority;


  // Use a transaction for atomicity
  const updateTransaction = db.transaction(() => {
    if (oldStatus === newStatus) {
      // Same lane - reordering within the lane
      if (oldPriority !== newPriority) {
        if (newPriority > oldPriority) {
          // Moving down: shift cards between old and new position up
          db.prepare(`
            UPDATE clients
            SET priority = priority - 1
            WHERE status = ? AND priority > ? AND priority <= ?
          `).run(oldStatus, oldPriority, newPriority);
        } else {
          // Moving up: shift cards between new and old position down
          db.prepare(`
            UPDATE clients
            SET priority = priority + 1
            WHERE status = ? AND priority >= ? AND priority < ?
          `).run(oldStatus, newPriority, oldPriority);
        }
        // Update the moved client's priority
        db.prepare('UPDATE clients SET priority = ? WHERE id = ?').run(newPriority, id);
      }
    } else {
      // Moving to different lane
      // 1. Remove from old lane - shift all cards after it up
      db.prepare(`
        UPDATE clients
        SET priority = priority - 1
        WHERE status = ? AND priority > ?
      `).run(oldStatus, oldPriority);

      // 2. Make room in new lane - shift cards at and after new position down
      db.prepare(`
        UPDATE clients
        SET priority = priority + 1
        WHERE status = ? AND priority >= ?
      `).run(newStatus, newPriority);

      // 3. Update the moved client's status and priority
      db.prepare('UPDATE clients SET status = ?, priority = ? WHERE id = ?').run(newStatus, newPriority, id);
    }
  });

  updateTransaction();

  // Return all clients sorted by status and priority
  const clients = db.prepare('select * from clients order by status, priority asc').all();
  return res.status(200).send(clients);
});

app.listen(3001);
console.log('app running on port ', 3001);
