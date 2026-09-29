/**
 * The limits on a project's command list, shared by the settings page and the
 * server. Kept apart from the store so the frontend bundle can read them
 * without pulling in the server's imports.
 */
export const MAX_COMMANDS_PER_PROJECT = 12;
export const MAX_COMMAND_NAME_LENGTH = 60;
export const MAX_COMMAND_LENGTH = 2000;
