import assert from "node:assert/strict";

// Source import requires the host plugin's peer dependencies. In a bare checkout,
// point this at the refreshed profile copy (same hash as the workspace source).
const modulePath = process.env.DSH_MOBILE_REMOTE_MODULE ?? new URL("../lib/index.js", import.meta.url).href;
const { validateQuestionAnswers } = await import(modulePath);

const questions = [
	{
		id: "q1",
		options: [{ label: "yes" }, { label: "no" }],
		multiSelect: false,
	},
	{
		id: "q2",
		options: [{ label: "a" }, { label: "b" }],
		multiSelect: true,
	},
];

assert.deepEqual(validateQuestionAnswers(questions, [
	{ id: "q1", selected: ["yes"] },
	{ id: "q2", selected: ["a"], custom: "also" },
]), { ok: true });
assert.equal(validateQuestionAnswers(questions, [
	{ id: "q1", selected: ["unknown"] },
	{ id: "q2", selected: ["a"] },
]).code, "question-answer-invalid");
assert.equal(validateQuestionAnswers(questions, [
	{ id: "q1", selected: ["yes", "no"] },
	{ id: "q2", selected: ["a"] },
]).code, "question-answer-invalid");
assert.equal(validateQuestionAnswers(questions, [
	{ id: "q1", selected: ["yes"] },
]).code, "question-answer-invalid");
assert.equal(validateQuestionAnswers(questions, [
	{ id: "q1", selected: ["yes"], custom: "conflict" },
	{ id: "q2", selected: ["a"] },
]).code, "question-answer-invalid");

console.log("RC1 question answer checks passed");
