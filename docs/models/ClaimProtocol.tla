------------------------- MODULE ClaimProtocol -------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Attested
VARIABLES phase, live, owner, trusted, fresh, forged, recovery, writes
vars == <<phase, live, owner, trusted, fresh, forged, recovery, writes>>
Init == /\ phase = "ready" /\ live = {} /\ owner = 0
        /\ trusted = FALSE /\ fresh = FALSE /\ forged = FALSE
        /\ recovery = 0 /\ writes = FALSE
Claim(a) == /\ phase = "ready" /\ a \in {1, 2}
            /\ phase' = "working" /\ live' = {a} /\ owner' = a
            /\ trusted' = TRUE /\ fresh' = TRUE /\ recovery' = 0
            /\ UNCHANGED <<forged, writes>>
Crash == /\ live # {} /\ live' = {} /\ UNCHANGED <<phase, owner, trusted, fresh, forged, recovery, writes>>
Expire == /\ fresh /\ fresh' = FALSE /\ UNCHANGED <<phase, live, owner, trusted, forged, recovery, writes>>
Forge == /\ forged' = TRUE /\ UNCHANGED <<phase, live, owner, trusted, fresh, recovery, writes>>
Recover == /\ phase = "working" /\ live = {} /\ ~fresh
           /\ (trusted \/ (~Attested /\ forged))
           /\ phase' = "ready" /\ owner' = 0 /\ recovery' = 1
           /\ writes' = ~trusted /\ UNCHANGED <<live, trusted, fresh, forged>>
FakeClaim == /\ ~Attested /\ forged /\ phase = "ready"
             /\ phase' = "working" /\ owner' = 0 /\ trusted' = FALSE
             /\ UNCHANGED <<live, fresh, forged, recovery, writes>>
Finish(p) == /\ phase = "working" /\ live # {} /\ p \in {"review", "blocked", "triage"}
             /\ phase' = p /\ live' = {} /\ UNCHANGED <<owner, trusted, fresh, forged, recovery, writes>>
Next == (\E a \in {1, 2}: Claim(a)) \/ Crash \/ Expire \/ Forge \/ Recover \/ FakeClaim
        \/ (\E p \in {"review", "blocked", "triage"}: Finish(p))
\* Invariants
OneLiveClaimant == Cardinality(live) <= 1
NoUnattestedWrite == ~writes
RecoveryAttested == recovery = 0 \/ trusted
RecoverableCrash == phase # "working" \/ live # {} \/ trusted
Spec == Init /\ [][Next]_vars /\ WF_vars(Expire) /\ WF_vars(Recover)
\* Bounds: two possible runners, one attacker, one live claim, one TTL expiry.
\* Weak fairness of Expire and Recover supplies liveness; attacker stuttering
\* cannot disable either. RecoverableCrash checks the enabling premise in all states.
=============================================================================
