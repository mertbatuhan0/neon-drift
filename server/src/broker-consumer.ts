export type BrokerConsumerOptions = {
  baseUrl: string;
  user: string;
  password: string;
  group: string;
  topic: string;
  instance?: string;
  fetchImpl?: typeof fetch;
};

export type BrokerConsumer = {
  poll: () => Promise<unknown[]>;
  close: () => Promise<void>;
};

function authHeader(user: string, password: string) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

export function consumerBase(publicRoot: string, baseUri: string) {
  const external = new URL(publicRoot);
  const internal = new URL(baseUri);
  return `${external.origin}${internal.pathname}`.replace(/\/$/, "");
}

async function call(
  fetchImpl: typeof fetch,
  url: string,
  user: string,
  password: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
) {
  const res = await fetchImpl(url, {
    method,
    headers: {
      Authorization: authHeader(user, password),
      "Content-Type": "application/vnd.kafka.v2+json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

export async function openBrokerConsumer(options: BrokerConsumerOptions): Promise<BrokerConsumer> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const root = options.baseUrl.replace(/\/$/, "");
  const name = options.instance ?? "leaderboard";
  const groupUrl = `${root}/consumers/${options.group}`;
  let baseUri = "";

  async function removeInstance() {
    await call(
      fetchImpl,
      `${groupUrl}/instances/${name}`,
      options.user,
      options.password,
      "DELETE",
      {},
    );
  }

  async function create() {
    const payload = {
      name,
      format: "json",
      "auto.offset.reset": "earliest",
    };
    const headers = { "Content-Type": "application/vnd.kafka.v2+json" };
    const post = () => call(fetchImpl, groupUrl, options.user, options.password, "POST", headers, payload);
    await removeInstance();
    let created = await post();
    if (created.status === 409 || created.status >= 500) {
      await removeInstance();
      created = await post();
    }
    if (created.status < 200 || created.status >= 300) {
      throw new Error(`broker consumer create -> ${created.status} ${created.text.slice(0, 160)}`);
    }
    let parsed: { base_uri?: string } = {};
    if (created.text) {
      try {
        parsed = JSON.parse(created.text) as { base_uri?: string };
      } catch {
        parsed = {};
      }
    }
    const rawBase = parsed.base_uri || `${groupUrl}/instances/${name}`;
    baseUri = consumerBase(root, rawBase);
    const subscribed = await call(
      fetchImpl,
      `${baseUri}/subscription`,
      options.user,
      options.password,
      "POST",
      headers,
      { topics: [options.topic] },
    );
    if (subscribed.status < 200 || subscribed.status >= 300) {
      throw new Error(`broker consumer subscribe -> ${subscribed.status} ${subscribed.text.slice(0, 160)}`);
    }
  }

  await create();

  return {
    async poll() {
      const result = await call(
        fetchImpl,
        `${baseUri}/records?timeout=3000`,
        options.user,
        options.password,
        "GET",
        { Accept: "application/vnd.kafka.json.v2+json" },
      );
      if (result.status === 404) {
        await create();
        return [];
      }
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`broker consumer poll -> ${result.status} ${result.text.slice(0, 160)}`);
      }
      if (!result.text) return [];
      const parsed = JSON.parse(result.text) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.map((row) => {
        if (row && typeof row === "object" && "value" in row) return (row as { value: unknown }).value;
        return row;
      });
    },
    async close() {
      if (!baseUri) return;
      await call(fetchImpl, baseUri, options.user, options.password, "DELETE", {}).catch(() => undefined);
    },
  };
}
