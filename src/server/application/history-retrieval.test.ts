import { describe, expect, it } from "vitest";
import {
  rankHistory,
  type HistoryRankItem
} from "@/server/application/history-retrieval";

const JANUARY = "2026-01-01T00:00:00.000Z";

function item(
  id: string,
  content: string,
  createdAt: string = JANUARY
): HistoryRankItem {
  return { id, content, contentFormat: "text", createdAt };
}

function jsonItem(
  id: string,
  value: unknown,
  createdAt: string = JANUARY
): HistoryRankItem {
  return {
    id,
    content: JSON.stringify(value),
    contentFormat: "json",
    createdAt
  };
}

const ids = (ranked: HistoryRankItem[]) => ranked.map((candidate) => candidate.id);

// The measured 13-word sentence and its 225-word padded twin: the same
// sentence plus 212 words of chatter, which the ranker must not reward.
const SENTENCE =
  "The persistence model should use SQLite and a refresh writes a new revision";
const CHATTERED = `${SENTENCE} ${Array.from({ length: 212 }, () => "chatter").join(" ")}`;

// The measured 89-word item: 80 repetitions of one query term plus the nine
// other query terms, against a 14-word item holding the five rare on-topic
// terms.
const RARE = ["sqlite", "postgres", "durability", "migration", "tombstone"];
const COMMON = [
  "store",
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india"
];
const ON_TOPIC = `${RARE.join(" ")} should be decided before we choose this today yet`;
const REPEATED = `${Array.from({ length: 80 }, () => "store").join(" ")} ${COMMON.slice(1).join(" ")}`;

// Query order is chosen so no two vertically adjacent tokens in any fixture sit
// adjacent in query order: the phrase boost must stay out of these fixtures.
const MEASURED_QUERY = [
  "sqlite",
  "store",
  "postgres",
  "alpha",
  "durability",
  "bravo",
  "migration",
  "charlie",
  "tombstone",
  "delta",
  "hotel",
  "echo",
  "india",
  "foxtrot",
  "golf"
].join(" ");

describe("rankHistory", () => {
  it("returns only the items matching at least one query term", () => {
    const items = [
      item("weather", "Unrelated text about weather."),
      item("store", "The persistence model should use SQLite."),
      item("poetry", "A paragraph about summer rain.")
    ];

    expect(ids(rankHistory(items, "persistence SQLite"))).toEqual(["store"]);
  });

  it("returns nothing for a query with no terms, unlike rankChunks", () => {
    const items = [item("store", "SQLite is the store.")];

    expect(rankHistory(items, "   ")).toEqual([]);
  });

  it("ranks a match on a rare term above a match on a common one", () => {
    const fillers = Array.from({ length: 9 }, (_, index) =>
      item(`filler-${index}`, "Migrations deserve their own section.")
    );
    const rare = item("rare", "SQLite is the store.");

    expect(ids(rankHistory([...fillers, rare], "sqlite migrations"))[0]).toBe(
      "rare"
    );
  });

  it("does not reward a sentence padded with 212 words of chatter", () => {
    const ranked = rankHistory(
      [item("chattered", CHATTERED), item("sentence", SENTENCE)],
      "persistence SQLite"
    );

    expect(ids(ranked)).toEqual(["sentence", "chattered"]);
  });

  it("does not let 80 repetitions of one query term beat the rare on-topic terms", () => {
    const items = [
      item("repeated", REPEATED),
      item("on-topic", ON_TOPIC),
      // Two items carrying every query term fix the document frequency the
      // comparison depends on; the assertion is on the two above.
      item("filler-a", COMMON.join(" ")),
      item("filler-b", COMMON.join(" ")),
      ...Array.from({ length: 4 }, (_, index) =>
        item(`unrelated-${index}`, "A paragraph about summer rain.")
      )
    ];

    const ranked = ids(rankHistory(items, MEASURED_QUERY));

    expect(ranked.indexOf("on-topic")).toBeLessThan(ranked.indexOf("repeated"));
  });

  it("ranks an item quoting the query verbatim above an equally long scattered match", () => {
    const items = [
      item(
        "scattered",
        "Persistence in isolation is cheap and the data model today"
      ),
      item("verbatim", "The persistence model should use SQLite and nothing at all")
    ];

    expect(ids(rankHistory(items, "persistence model"))[0]).toBe("verbatim");
  });

  it("does not let a padded item win by quoting the query back", () => {
    const quoting = Array.from({ length: 8 }, () => "persistence model").join(
      " "
    );

    expect(
      ids(
        rankHistory(
          [item("quoting", quoting), item("answer", "Persistence model.")],
          "persistence model"
        )
      )[0]
    ).toBe("answer");
  });

  it("does not let a phrase span two JSON fields", () => {
    const items = [
      jsonItem("split", {
        context: "the persistence",
        problem: "model failed"
      }),
      item(
        "together",
        "the persistence model is fine and settled here now okay"
      )
    ];

    expect(ids(rankHistory(items, "persistence model"))[0]).toBe("together");
  });

  it("does not score a JSON item on its structural keys, but does score its values", () => {
    const query = "context problem options actions constraints assumptions";
    const offTopic = jsonItem("brief", {
      schemaVersion: 2,
      context: "Office plants",
      problem: "The ficus is dry",
      options: [{ actions: ["water it"], constraints: ["weekends only"] }],
      assumptions: ["someone remembers"]
    });
    const onTopic = item(
      "message",
      "Our context, problem, options, actions, constraints and assumptions are all here."
    );

    expect(ids(rankHistory([offTopic, onTopic], query))).toEqual(["message"]);
    expect(ids(rankHistory([offTopic, onTopic], "ficus"))).toEqual(["brief"]);
  });

  it("tokenises a JSON item literally when its content does not parse", () => {
    const broken: HistoryRankItem = {
      id: "broken",
      content: '{"context": sqlite',
      contentFormat: "json",
      createdAt: JANUARY
    };

    expect(ids(rankHistory([broken], "sqlite"))).toEqual(["broken"]);
  });

  it("orders an otherwise tied group oldest first", () => {
    const tied = (id: string, createdAt: string) =>
      item(id, "SQLite is the store.", createdAt);

    const items = [
      tied("newest", "2026-07-01T00:00:00.000Z"),
      tied("oldest", "2025-04-01T00:00:00.000Z"),
      tied("middle", "2025-11-01T00:00:00.000Z")
    ];

    expect(ids(rankHistory(items, "sqlite"))).toEqual([
      "oldest",
      "middle",
      "newest"
    ]);
  });

  // The fixture is chosen so the two leaders' idf sums coincide *exactly* in
  // floating point — log(1 + 9/1) === log(1 + 9/6) + log(1 + 9/3) — which is
  // what makes coverage the deciding key rather than a near-miss on score. The
  // low-coverage item is listed first, and the query is ordered so "beta gamma"
  // is not adjacent in query order, which keeps the phrase boost out of the
  // fixture and leaves coverage as the only live key.
  it("orders by distinct query terms when the scores are equal", () => {
    const items = [
      item("one-term", "alpha x y"),
      item("two-terms", "beta gamma z"),
      item("c", "beta p q"),
      item("d", "beta p q"),
      item("e", "beta p q"),
      item("f", "beta p q"),
      item("g", "beta p q"),
      item("h", "gamma r s"),
      item("i", "gamma r s")
    ];

    expect(ids(rankHistory(items, "beta alpha gamma")).slice(0, 2)).toEqual([
      "two-terms",
      "one-term"
    ]);
  });

  // Recency is the tertiary key and nothing more: no decay term participates
  // in the score, so age can reorder a tie but can never outrank relevance.
  it("treats recency as the tie-break and nothing more", () => {
    const fillers = Array.from({ length: 6 }, (_, index) =>
      item(`filler-${index}`, "Migrations deserve their own section.")
    );
    const oldRelevant = item(
      "old-relevant",
      "SQLite is the store.",
      "2020-01-01T00:00:00.000Z"
    );
    const newMarginal = item(
      "new-marginal",
      "Migrations matter.",
      "2026-08-01T00:00:00.000Z"
    );

    expect(
      ids(rankHistory([...fillers, newMarginal, oldRelevant], "sqlite migrations"))[0]
    ).toBe("old-relevant");
  });

  it("counts a repeated query term once", () => {
    const items = [
      item("one-term", "SQLite is mentioned here."),
      item("two-terms", "Durability and migration are separate questions.")
    ];

    expect(ids(rankHistory(items, "sqlite durability migration"))).toEqual([
      "two-terms",
      "one-term"
    ]);
    expect(ids(rankHistory(items, "sqlite sqlite durability migration"))).toEqual(
      ["two-terms", "one-term"]
    );
  });

  it("is deterministic for identical input and independent of input order", () => {
    const items = [
      item("a", "SQLite durability is the question."),
      item("b", "Migrations deserve their own section."),
      item("c", "SQLite is the store.")
    ];
    const query = "sqlite durability migrations";

    expect(ids(rankHistory(items, query))).toEqual(ids(rankHistory(items, query)));
    expect(ids(rankHistory(items, query))).toEqual(
      ids(rankHistory([...items].reverse(), query))
    );
  });
});
