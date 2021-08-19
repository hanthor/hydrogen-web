# Typescript migration
 
## Introduce `abstract` & `override`

 - find all methods and getters that throw or are empty in base classes and turn into abstract method or if all methods are abstract, into an interface.
 - change child impls to not call super.method and to add override
 - don't allow implicit override in ts config

## Consider remove named constructor parameters

as typing should make it considerably harder to mess up parameter order, we could consider removing the named parameters we have everywhere in the constructor.
