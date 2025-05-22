export const tool = {
  name: "listMessages",
  description: "List the user's Gmail messages",
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
  async run({ auth, input }) {
    const token = auth.oauth_access_token;
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${input.maxResults || 5}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );
    return await res.json();
  },
};

