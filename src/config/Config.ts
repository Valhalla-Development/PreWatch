import { z } from 'zod';

// Helper transforms for common patterns
const stringToBoolean = (val: string): boolean => val.toLowerCase() === 'true';
const stringToArray = (val: string): string[] => {
    return val
        ? val
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
        : [];
};

const configSchema = z.object({
    // Required bot token
    BOT_TOKEN: z.string().min(1, 'Bot token is required'),

    // Required API URL
    API_URL: z.url('API_URL must be a valid URL'),

    // Environment (defaults to development)
    NODE_ENV: z.enum(['development', 'production']).default('development'),

    // Optional comma-separated guild IDs (undefined = global, string[] = guild-specific)
    GUILDS: z
        .string()
        .optional()
        .transform((val) => (val ? stringToArray(val) : undefined)),

    // Logging settings
    ENABLE_LOGGING: z.string().optional().default('false').transform(stringToBoolean),
    ERROR_LOGGING_CHANNEL: z.string().optional(),
    COMMAND_LOGGING_CHANNEL: z.string().optional(),
});

// Parse config with error handling
let config: z.infer<typeof configSchema>;
try {
    config = configSchema.parse(process.env);

    // Validate logging channels required when logging is enabled
    if (config.ENABLE_LOGGING && !config.ERROR_LOGGING_CHANNEL && !config.COMMAND_LOGGING_CHANNEL) {
        console.warn(
            '⚠️  ENABLE_LOGGING is true but ERROR_LOGGING_CHANNEL and COMMAND_LOGGING_CHANNEL are missing. Logging will be disabled.'
        );
        config.ENABLE_LOGGING = false;
    }
} catch (error) {
    if (error instanceof z.ZodError) {
        const missingVars = error.issues
            .map((issue) => `${String(issue.path[0])}: ${issue.message}`)
            .join(', ');

        throw new Error(`Configuration validation failed: ${missingVars}`);
    }
    throw error;
}

export { config };
export const isDev = config.NODE_ENV === 'development';
