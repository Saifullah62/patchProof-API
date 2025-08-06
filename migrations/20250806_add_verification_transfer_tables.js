// Migration for verification codes and transfer requests
exports.up = function(knex) {
  return Promise.all([
    knex.schema.createTable('verification_codes', function(table) {
      table.string('identifier').primary();
      table.string('code').notNullable();
      table.bigInteger('expires_at').notNullable();
    }),
    knex.schema.createTable('transfer_requests', function(table) {
      table.string('txid').primary();
      table.json('transfer_request').notNullable();
      table.bigInteger('expires_at').notNullable();
    })
  ]);
};

exports.down = function(knex) {
  return Promise.all([
    knex.schema.dropTableIfExists('verification_codes'),
    knex.schema.dropTableIfExists('transfer_requests')
  ]);
};
