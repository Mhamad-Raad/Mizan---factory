-- The API checks for a pending migration at start-up (spec 2.14) and refuses to serve while
-- one is. It used to read `mizan_migrations` as the migrate role, which meant the API container
-- carried the credentials of the role that owns the schema — for the sake of one SELECT
-- (security review, finding 9). Reading the list is all the application role needs, and all it
-- is given: no INSERT, UPDATE or DELETE, so it can neither fake nor forget an applied migration.

GRANT SELECT ON mizan_migrations TO mizan_app;
