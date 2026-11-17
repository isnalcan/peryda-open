import Foundation
import Testing
@testable import PerydaKit

/// Owner, 17 Nov 2026: each job has its own model and thinking level, the blind test's choice by
/// default (same as web/src/ai/jobs.test.ts), with the estimated cost behind an (i)
/// (web/src/settings/costEstimates.test.ts).
@Suite struct JobChoicesTests {
    let empty = ByokSettings()

    @Test func defaultsToTheBlindTestOf17November() {
        func row(_ p: ProviderID) -> [String] {
            AITask.allCases.map { "\(empty.model(for: p, task: $0)) \(empty.effort(for: p, task: $0)?.rawValue ?? "-")" }
        }
        // thread, area, translation, scan, summary
        #expect(row(.gemini) == ["gemini-4-hydrogen medium", "gemini-3.8-flash low", "gemini-4-hydrogen low", "gemini-4-hydrogen low", "gemini-3.8-flash low"])
        #expect(row(.openai) == ["gpt-6.1-sol low", "gpt-6.1-sol medium", "gpt-6.1-sol low", "gpt-6.1-sol low", "gpt-6.1-sol low"])
        #expect(row(.claude) == ["claude-sonnet-5-5 medium", "claude-sonnet-5-5 low", "claude-haiku-5-5 medium", "claude-haiku-5-5 medium", "claude-sonnet-5-5 low"])
        // DeepSeek was not tested: no level is sent unless the reader picks one.
        for t in AITask.allCases { #expect(empty.effort(for: .deepseek, task: t) == nil) }
    }

    @Test func deepSeekPicturesGoToFlashEvenWhenTheReasoningModelIsChosen() {
        var s = empty
        s.setModel("deepseek-v4-pro", for: .deepseek, task: .area)
        s.setModel("deepseek-v4-pro", for: .deepseek, task: .thread)
        #expect(s.model(for: .deepseek, task: .area) == "deepseek-flash")
        #expect(s.model(for: .deepseek, task: .scan) == "deepseek-flash")
        #expect(s.model(for: .deepseek, task: .thread) == "deepseek-v4-pro")
    }

    @Test func keepsChoicesGoesBackToRecommendedAndLoadsOldSettings() throws {
        var s = empty
        s.setModel("gpt-6-luna", for: .openai, task: .translation)
        s.setEffort(.high, for: .openai, task: .translation)
        s.setModel("gemini-4-hydrogen", for: .gemini, task: .summary)
        #expect(s.model(for: .openai, task: .translation) == "gpt-6-luna")
        #expect(s.effort(for: .openai, task: .translation) == .high)
        #expect(s.model(for: .gemini, task: .summary) == "gemini-4-hydrogen")
        #expect(!s.usesRecommended(.openai))
        var back = s
        back.useRecommended(for: .openai)
        #expect(back.usesRecommended(.openai))
        #expect(back.model(for: .gemini, task: .summary) == "gemini-4-hydrogen")
        // Saved and loaded again; junk keys are dropped.
        var json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(s)) as? [String: Any])
        var choices = try #require(json["choices"] as? [String: String])
        choices["x.y.z"] = "a"
        json["choices"] = choices
        let loaded = try JSONDecoder().decode(ByokSettings.self, from: JSONSerialization.data(withJSONObject: json))
        #expect(loaded.choices == s.choices)
        let old = try JSONDecoder().decode(ByokSettings.self, from: Data(#"{"geminiModel":"gemini-3.8-flash"}"#.utf8))
        #expect(old.choices.isEmpty)
        #expect(old.model(for: .gemini, task: .thread) == "gemini-3.8-flash")
    }

    @Test func noLevelForAModelThatDoesNotTakeOne() {
        var s = empty
        s.setModel("gpt-4o", for: .openai, task: .thread)
        #expect(s.effort(for: .openai, task: .thread) == nil)
        #expect(!ModelAdvice.acceptsEffort(.claude, "claude-haiku-4-5"))
        #expect(ModelAdvice.acceptsEffort(.claude, "claude-sonnet-5-5"))
        #expect(!ModelAdvice.acceptsEffort(.gemini, "gemini-2.5-flash"))
        #expect(!ModelAdvice.acceptsTemperature(.openai, "gpt-6.1-sol"))
        #expect(ModelAdvice.acceptsTemperature(.openai, "gpt-4o"))
    }

    func body(_ req: AIRequest) throws -> [String: Any] {
        let data = try #require(try AIClient().urlRequest(for: req).httpBody)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func theLevelInEachRequest() throws {
        let turns = [AITurn(role: .user, parts: [.text("q")])]
        let key = "placeholder-key-0000"
        let o = try body(AIRequest(provider: .openai, apiKey: key, model: "gpt-6.1-sol", system: "s", turns: turns, temperature: 0.55, effort: .low))
        #expect(o["reasoning_effort"] as? String == "low")
        #expect(o["temperature"] == nil)
        let c = try body(AIRequest(provider: .claude, apiKey: key, model: "claude-sonnet-5-5", system: "s", turns: turns, effort: .medium))
        #expect((c["output_config"] as? [String: Any])?["effort"] as? String == "medium")
        let g = try body(AIRequest(provider: .gemini, apiKey: key, model: "gemini-4-hydrogen", system: "s", turns: turns, effort: .low,
                                   candidates: ModelAdvice.geminiChain(selected: "gemini-4-hydrogen", effort: .low)))
        #expect(((g["generationConfig"] as? [String: Any])?["thinkingConfig"] as? [String: Any])?["thinkingLevel"] as? String == "low")
        let none = try body(AIRequest(provider: .openai, apiKey: key, model: "gpt-6.1-sol", system: "s", turns: turns))
        #expect(none["reasoning_effort"] == nil)
        let older = try body(AIRequest(provider: .claude, apiKey: key, model: "claude-haiku-4-5", system: "s", turns: turns, effort: .low))
        #expect(older["output_config"] == nil)
    }

    @Test func aGeminiBatchJobCarriesTheLevel() throws {
        let item = GeminiBatch.Item(key: "1", system: "s", turns: [AITurn(role: .user, parts: [.text("p")])])
        let batch = try #require(GeminiBatch.createBody([item], model: "gemini-4-hydrogen", effort: .low)["batch"] as? [String: Any])
        let requests = try #require(((batch["input_config"] as? [String: Any])?["requests"] as? [String: Any])?["requests"] as? [[String: Any]])
        let config = try #require((requests[0]["request"] as? [String: Any])?["generationConfig"] as? [String: Any])
        #expect((config["thinkingConfig"] as? [String: Any])?["thinkingLevel"] as? String == "low")
    }

    @Test func everyRecommendedJobOfTheTestedProvidersHasAnEstimate() {
        for p in [ProviderID.gemini, .openai, .claude] {
            for t in AITask.allCases {
                let d = SharedContract.costs.dollars(model: empty.model(for: p, task: t), effort: empty.effort(for: p, task: t), task: t)
                #expect(d != nil, "\(p) \(t)")
                #expect((d ?? 0) > 0 && (d ?? 1) < 0.05)
            }
        }
        #expect(SharedContract.costs.dollars(model: empty.model(for: .deepseek, task: .thread), effort: empty.effort(for: .deepseek, task: .thread), task: .thread) == nil)
        #expect(CostEstimates.format(0.0058, lang: .en) == "$0.0058")
        #expect(CostEstimates.format(0.0058, lang: .tr).contains("0,0058"))
        #expect(CostEstimates.batchApplies(.gemini, .translation))
        #expect(!CostEstimates.batchApplies(.openai, .translation))
        #expect(!CostEstimates.batchApplies(.gemini, .thread))
    }
}
