export const tool = {
  name: "listMessages",
  description: "Test tool to verify registration",
  inputSchema: {
    type: "object",
    properties: {
      maxResults: {
        type: "number",
        default: 5,
      },
    },
    required: [],
  },
  async run({ input }) {
    return {
      ok: true,
      receivedMaxResults: input.maxResults || 5,
    };
  },
};
